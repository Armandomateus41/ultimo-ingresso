import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarBanco, type Banco } from "../src/servidor/banco";
import {
  ASSENTO_DA_DISPUTA,
  carregarMapa,
  confirmar,
  criarSessao,
  ErroDeReserva,
  expirarVencidas,
  prepararDisputa,
  reservar,
} from "../src/servidor/reservas";
import { URL_DO_BANCO_DE_TESTE } from "./preparar-banco-de-teste";

/*
 * Testes de integração contra um Postgres de verdade (o do docker-compose, banco ultimo_ingresso_teste).
 * Cada tentativa simultânea usa a sua própria conexão do pool, como duas requisições HTTP independentes.
 */

let banco: Banco;

beforeAll(() => {
  banco = criarBanco(URL_DO_BANCO_DE_TESTE, 30);
});

afterAll(async () => {
  await banco.end();
});

const chave = () => randomUUID();

async function reservasValidas(sessao: string, assentoId: string) {
  const { rows } = await banco.query<{ comprador: string }>(
    `SELECT comprador FROM reservas
     WHERE sessao_id = $1 AND assento_id = $2 AND status IN ('ativa', 'confirmada')`,
    [sessao, assentoId],
  );
  return rows;
}

/** Um assento livre na sessão (o público fictício já ocupa parte do mapa). */
async function assentoLivre(sessao: string, setor: string) {
  const mapa = await carregarMapa(banco, sessao);
  const livre = mapa.assentos.find((a) => a.setor === setor && a.estado === "livre" && a.id !== ASSENTO_DA_DISPUTA);
  if (!livre) throw new Error(`Nenhum assento livre no setor ${setor}`);
  return livre.id;
}

function comoErro(motivo: unknown): ErroDeReserva {
  expect(motivo).toBeInstanceOf(ErroDeReserva);
  return motivo as ErroDeReserva;
}

describe("disputa pelo mesmo assento", () => {
  it("duas tentativas simultâneas produzem exatamente uma reserva", async () => {
    const sessao = await criarSessao(banco);

    // 40 rodadas para dar muitas chances à corrida aparecer, se ela existisse.
    for (let rodada = 0; rodada < 40; rodada++) {
      await prepararDisputa(banco, sessao);

      const [ana, bruno] = await Promise.allSettled([
        reservar(banco, { sessao, assentoId: ASSENTO_DA_DISPUTA, comprador: "Ana", chave: chave() }),
        reservar(banco, { sessao, assentoId: ASSENTO_DA_DISPUTA, comprador: "Bruno", chave: chave() }),
      ]);

      const vitorias = [ana, bruno].filter((r) => r.status === "fulfilled");
      const derrotas = [ana, bruno].filter((r) => r.status === "rejected");
      expect(vitorias).toHaveLength(1);
      expect(derrotas).toHaveLength(1);

      const vencedor = (vitorias[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof reservar>>>).value.reserva.comprador;
      const erro = comoErro((derrotas[0] as PromiseRejectedResult).reason);
      expect(erro.status).toBe(409);
      expect(erro.codigo).toBe("assento_ocupado");
      expect(erro.dados.ocupadoPor).toMatchObject({ comprador: vencedor, estado: "reservado" });

      // A alternativa oferecida é outro assento, e está livre de verdade.
      const alternativa = erro.dados.alternativa as { id: string };
      expect(alternativa.id).not.toBe(ASSENTO_DA_DISPUTA);
      expect(await reservasValidas(sessao, alternativa.id)).toHaveLength(0);

      const noBanco = await reservasValidas(sessao, ASSENTO_DA_DISPUTA);
      expect(noBanco).toEqual([{ comprador: vencedor }]);
    }
  });

  it("vinte compradores ao mesmo tempo: um consegue, dezenove recebem 409", async () => {
    const sessao = await criarSessao(banco);
    const assentoId = await assentoLivre(sessao, "CEN");
    const tentativas = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        reservar(banco, { sessao, assentoId, comprador: `Comprador ${i + 1}`, chave: chave() }),
      ),
    );
    expect(tentativas.filter((t) => t.status === "fulfilled")).toHaveLength(1);
    const recusas = tentativas.filter((t): t is PromiseRejectedResult => t.status === "rejected");
    expect(recusas).toHaveLength(19);
    for (const recusa of recusas) expect(comoErro(recusa.reason).status).toBe(409);
    expect(await reservasValidas(sessao, assentoId)).toHaveLength(1);
  });

  it("cada sessão tem o seu show: o mesmo assento pode ser reservado em sessões diferentes", async () => {
    const [primeira, segunda] = await Promise.all([criarSessao(banco), criarSessao(banco)]);
    const [a, b] = await Promise.all([
      reservar(banco, { sessao: primeira, assentoId: ASSENTO_DA_DISPUTA, comprador: "Ana", chave: chave() }),
      reservar(banco, { sessao: segunda, assentoId: ASSENTO_DA_DISPUTA, comprador: "Bruno", chave: chave() }),
    ]);
    expect(a.criada).toBe(true);
    expect(b.criada).toBe(true);
  });
});

describe("clique duplo", () => {
  it("o mesmo pedido enviado duas vezes ao mesmo tempo vira uma reserva só", async () => {
    const sessao = await criarSessao(banco);
    const pedido = { sessao, assentoId: ASSENTO_DA_DISPUTA, comprador: "Você", chave: chave() };
    const [primeiro, segundo] = await Promise.all([reservar(banco, pedido), reservar(banco, pedido)]);

    expect(primeiro.reserva.id).toBe(segundo.reserva.id);
    expect([primeiro.criada, segundo.criada].sort()).toEqual([false, true]);
    expect(await reservasValidas(sessao, ASSENTO_DA_DISPUTA)).toHaveLength(1);
  });
});

describe("confirmação duplicada", () => {
  it("duas confirmações simultâneas emitem um ingresso só", async () => {
    const sessao = await criarSessao(banco);
    const { reserva } = await reservar(banco, { sessao, assentoId: ASSENTO_DA_DISPUTA, comprador: "Você", chave: chave() });

    const [primeira, segunda] = await Promise.all([confirmar(banco, sessao, reserva.id), confirmar(banco, sessao, reserva.id)]);

    expect(primeira.ingresso.codigo).toBe(segunda.ingresso.codigo);
    expect([primeira.jaConfirmada, segunda.jaConfirmada].sort()).toEqual([false, true]);
    const { rows } = await banco.query("SELECT count(*)::int AS total FROM ingressos WHERE reserva_id = $1", [reserva.id]);
    expect(rows[0].total).toBe(1);

    const mapa = await carregarMapa(banco, sessao);
    expect(mapa.assentos.find((a) => a.id === ASSENTO_DA_DISPUTA)?.estado).toBe("vendido");
  });
});

describe("expiração", () => {
  it("confirmar uma reserva vencida é recusado e o assento volta a ficar livre", async () => {
    const sessao = await criarSessao(banco);
    const { reserva } = await reservar(banco, { sessao, assentoId: ASSENTO_DA_DISPUTA, comprador: "Você", chave: chave() });

    // Em vez de esperar o relógio, o teste faz a reserva vencer.
    await banco.query("UPDATE reservas SET expira_em = now() - interval '1 second' WHERE id = $1", [reserva.id]);

    const erro = comoErro(await confirmar(banco, sessao, reserva.id).catch((e) => e));
    expect(erro.status).toBe(410);
    expect(erro.codigo).toBe("reserva_vencida");

    const { rows } = await banco.query("SELECT status FROM reservas WHERE id = $1", [reserva.id]);
    expect(rows[0].status).toBe("expirada");
    const ingressos = await banco.query("SELECT 1 FROM ingressos WHERE reserva_id = $1", [reserva.id]);
    expect(ingressos.rowCount).toBe(0);

    const mapa = await carregarMapa(banco, sessao);
    expect(mapa.assentos.find((a) => a.id === ASSENTO_DA_DISPUTA)?.estado).toBe("livre");

    // Outra pessoa consegue reservar o assento liberado.
    const nova = await reservar(banco, { sessao, assentoId: ASSENTO_DA_DISPUTA, comprador: "Bruno", chave: chave() });
    expect(nova.criada).toBe(true);
  });

  it("a varredura de vencidas libera o assento sem ninguém tentar confirmar", async () => {
    const sessao = await criarSessao(banco);
    const assentoId = await assentoLivre(sessao, "SOL");
    const { reserva } = await reservar(banco, { sessao, assentoId, comprador: "Você", chave: chave() });
    await banco.query("UPDATE reservas SET expira_em = now() - interval '1 second' WHERE id = $1", [reserva.id]);

    expect(await expirarVencidas(banco, sessao)).toContain(assentoId);
    expect(await reservasValidas(sessao, assentoId)).toHaveLength(0);
  });

  it("uma reserva vencida não impede uma nova reserva no mesmo assento, mesmo antes da varredura", async () => {
    const sessao = await criarSessao(banco);
    const assentoId = await assentoLivre(sessao, "MAR");
    const { reserva } = await reservar(banco, { sessao, assentoId, comprador: "Ana", chave: chave() });
    await banco.query("UPDATE reservas SET expira_em = now() - interval '1 second' WHERE id = $1", [reserva.id]);

    const nova = await reservar(banco, { sessao, assentoId, comprador: "Bruno", chave: chave() });
    expect(nova.reserva.comprador).toBe("Bruno");
    expect(await reservasValidas(sessao, assentoId)).toEqual([{ comprador: "Bruno" }]);
  });
});
