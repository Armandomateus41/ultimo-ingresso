import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Banco } from "./banco";

/*
 * Regras de reserva. Tudo o que decide quem fica com um assento acontece aqui, dentro do Postgres.
 *
 * - Reservar: INSERT ... ON CONFLICT DO NOTHING contra o índice único parcial
 *   "reservas_uma_valida_por_assento". Se duas transações tentam o mesmo assento ao mesmo tempo,
 *   a segunda espera a primeira terminar dentro do banco e não insere nada. Não há "ler e depois gravar"
 *   no código da aplicação, então não existe janela de corrida.
 * - Expiração: uma reserva ativa vencida é marcada como "expirada" (sai do índice) antes de cada tentativa
 *   no mesmo assento, a cada leitura do mapa e a cada ciclo do canal de tempo real.
 * - Confirmar: UPDATE ... WHERE status = 'ativa' AND expira_em > now(). A linha fica travada durante a
 *   transação; uma segunda confirmação simultânea espera e encontra a reserva já confirmada.
 */

export const EVENTO_ID = "cais-2027";
/** O "último lugar" da disputa: o único assento livre do Camarote Lua em toda sessão nova. */
export const ASSENTO_DA_DISPUTA = "CAM-A-07";
export const DURACAO_DA_RESERVA_SEGUNDOS = Number(process.env.RESERVA_TTL_SEGUNDOS ?? 30);

export type EstadoDoAssento = "livre" | "reservado" | "vendido";

export type AssentoNoMapa = {
  id: string;
  setor: string;
  fila: string;
  numero: number;
  estado: EstadoDoAssento;
  comprador: string | null;
  reservaId: string | null;
  expiraEm: string | null;
};

export type Setor = { id: string; nome: string; precoCentavos: number };

export type Evento = { id: string; artista: string; turne: string; local: string; cidade: string; aconteceEm: string };

export type Mapa = {
  evento: Evento;
  setores: Setor[];
  assentos: AssentoNoMapa[];
  duracaoDaReservaSegundos: number;
  assentoDaDisputa: string;
  agora: string;
};

export type Reserva = {
  id: string;
  assentoId: string;
  comprador: string;
  status: "ativa" | "confirmada" | "expirada" | "cancelada";
  expiraEm: string;
  criadaEm: string;
  confirmadaEm: string | null;
};

export type Ingresso = { codigo: string; emitidoEm: string; reservaId: string };

export type Alternativa = { id: string; setor: string; nomeDoSetor: string; fila: string; numero: number; precoCentavos: number };

/** Erro de regra de negócio, com o código e o status HTTP que a API devolve. */
export class ErroDeReserva extends Error {
  constructor(
    readonly codigo: string,
    readonly status: number,
    mensagem: string,
    readonly dados: Record<string, unknown> = {},
  ) {
    super(mensagem);
  }
}

const COLUNAS_DA_RESERVA = `id, assento_id, comprador, status, expira_em, criada_em, confirmada_em`;

type LinhaDaReserva = {
  id: string;
  assento_id: string;
  comprador: string;
  status: Reserva["status"];
  expira_em: Date;
  criada_em: Date;
  confirmada_em: Date | null;
};

const paraReserva = (linha: LinhaDaReserva): Reserva => ({
  id: linha.id,
  assentoId: linha.assento_id,
  comprador: linha.comprador,
  status: linha.status,
  expiraEm: linha.expira_em.toISOString(),
  criadaEm: linha.criada_em.toISOString(),
  confirmadaEm: linha.confirmada_em?.toISOString() ?? null,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const sessaoValida = (id: string) => UUID.test(id);

async function emTransacao<T>(banco: Banco, trabalho: (conexao: PoolClient) => Promise<T>): Promise<T> {
  const conexao = await banco.connect();
  try {
    await conexao.query("BEGIN");
    const resultado = await trabalho(conexao);
    await conexao.query("COMMIT");
    return resultado;
  } catch (erro) {
    await conexao.query("ROLLBACK").catch(() => {});
    throw erro;
  } finally {
    conexao.release();
  }
}

async function exigirSessao(conexao: PoolClient | Banco, sessao: string) {
  if (!sessaoValida(sessao)) throw new ErroDeReserva("sessao_inexistente", 404, "Sessão não encontrada.");
  const { rowCount } = await conexao.query("SELECT 1 FROM sessoes WHERE id = $1", [sessao]);
  if (!rowCount) throw new ErroDeReserva("sessao_inexistente", 404, "Sessão não encontrada. Comece uma nova.");
}

/**
 * Público fictício da sessão: cerca de 40% dos assentos vendidos, o Camarote inteiro vendido menos o assento
 * da disputa, e alguns assentos reservados por outras pessoas que vencem nos próximos segundos
 * (para o mapa mudar sozinho enquanto o visitante olha).
 */
async function semearPublico(conexao: PoolClient, sessao: string) {
  await conexao.query(
    `INSERT INTO reservas (sessao_id, evento_id, assento_id, comprador, status, expira_em, chave_idempotencia, confirmada_em)
     SELECT $1, evento_id, id, 'Público', 'confirmada', now(), 'publico-' || id, now()
     FROM assentos
     WHERE evento_id = $2 AND id <> $3 AND (setor_id = 'CAM' OR abs(hashtext(id)) % 100 < 38)`,
    [sessao, EVENTO_ID, ASSENTO_DA_DISPUTA],
  );
  await conexao.query(
    `INSERT INTO reservas (sessao_id, evento_id, assento_id, comprador, status, expira_em, chave_idempotencia)
     SELECT $1, evento_id, id, 'Outro comprador', 'ativa',
            now() + make_interval(secs => 20 + abs(hashtext(id || 'prazo')) % 70), 'publico-' || id
     FROM assentos
     WHERE evento_id = $2 AND setor_id <> 'CAM' AND abs(hashtext(id)) % 100 BETWEEN 38 AND 41`,
    [sessao, EVENTO_ID],
  );
}

/** Cria uma sessão nova (e apaga as abandonadas há mais de 12 horas). */
export async function criarSessao(banco: Banco): Promise<string> {
  const sessao = randomUUID();
  await emTransacao(banco, async (conexao) => {
    await conexao.query("DELETE FROM sessoes WHERE criada_em < now() - interval '12 hours'");
    await conexao.query("INSERT INTO sessoes (id) VALUES ($1)", [sessao]);
    await semearPublico(conexao, sessao);
  });
  return sessao;
}

/** Volta a sessão ao estado inicial. */
export async function reiniciarSessao(banco: Banco, sessao: string): Promise<void> {
  await emTransacao(banco, async (conexao) => {
    await exigirSessao(conexao, sessao);
    await conexao.query("DELETE FROM reservas WHERE sessao_id = $1", [sessao]);
    await semearPublico(conexao, sessao);
  });
}

/** Marca como expiradas as reservas ativas vencidas da sessão. Devolve os assentos liberados. */
export async function expirarVencidas(banco: Banco | PoolClient, sessao: string): Promise<string[]> {
  const { rows } = await banco.query<{ assento_id: string }>(
    `UPDATE reservas SET status = 'expirada', atualizada_em = clock_timestamp()
     WHERE sessao_id = $1 AND status = 'ativa' AND expira_em <= now()
     RETURNING assento_id`,
    [sessao],
  );
  return rows.map((linha) => linha.assento_id);
}

/** Assinatura do estado da sessão: muda sempre que alguma reserva muda. O canal de tempo real compara isto. */
export async function assinaturaDaSessao(banco: Banco, sessao: string): Promise<string> {
  const { rows } = await banco.query<{ total: string; ultima: Date | null }>(
    "SELECT count(*) AS total, max(atualizada_em) AS ultima FROM reservas WHERE sessao_id = $1",
    [sessao],
  );
  return `${rows[0].total}:${rows[0].ultima?.toISOString() ?? "-"}`;
}

export async function carregarMapa(banco: Banco, sessao: string): Promise<Mapa> {
  await exigirSessao(banco, sessao);
  await expirarVencidas(banco, sessao);
  const [evento, setores, assentos, agora] = await Promise.all([
    banco.query(`SELECT id, artista, turne, local, cidade, acontece_em FROM eventos WHERE id = $1`, [EVENTO_ID]),
    banco.query(`SELECT id, nome, preco_centavos FROM setores WHERE evento_id = $1 ORDER BY ordem`, [EVENTO_ID]),
    banco.query(
      `SELECT a.id, a.setor_id, a.fila, a.numero, r.id AS reserva_id, r.status, r.comprador, r.expira_em
       FROM assentos a
       LEFT JOIN reservas r
         ON r.assento_id = a.id AND r.sessao_id = $1 AND r.evento_id = a.evento_id
        AND (r.status = 'confirmada' OR (r.status = 'ativa' AND r.expira_em > now()))
       WHERE a.evento_id = $2
       ORDER BY a.setor_id, a.fila, a.numero`,
      [sessao, EVENTO_ID],
    ),
    banco.query<{ agora: Date }>("SELECT clock_timestamp() AS agora"),
  ]);
  const e = evento.rows[0];
  return {
    evento: { id: e.id, artista: e.artista, turne: e.turne, local: e.local, cidade: e.cidade, aconteceEm: e.acontece_em.toISOString() },
    setores: setores.rows.map((s) => ({ id: s.id, nome: s.nome, precoCentavos: s.preco_centavos })),
    assentos: assentos.rows.map((a) => ({
      id: a.id,
      setor: a.setor_id,
      fila: a.fila,
      numero: a.numero,
      estado: a.status === "confirmada" ? "vendido" : a.status === "ativa" ? "reservado" : "livre",
      comprador: a.comprador ?? null,
      reservaId: a.reserva_id ?? null,
      expiraEm: a.status === "ativa" ? a.expira_em.toISOString() : null,
    })),
    duracaoDaReservaSegundos: DURACAO_DA_RESERVA_SEGUNDOS,
    assentoDaDisputa: ASSENTO_DA_DISPUTA,
    agora: agora.rows[0].agora.toISOString(),
  };
}

/** Assento livre mais parecido: o mais perto no mesmo setor; se o setor lotou, o de preço mais próximo, nas filas da frente e no meio. */
export async function buscarAlternativa(banco: Banco | PoolClient, sessao: string, assentoId: string): Promise<Alternativa | null> {
  const { rows } = await banco.query(
    `WITH alvo AS (
       SELECT a.id, a.evento_id, a.setor_id, a.fila, a.numero, s.preco_centavos
       FROM assentos a JOIN setores s ON s.id = a.setor_id WHERE a.id = $2
     )
     SELECT a.id, a.setor_id, s.nome, a.fila, a.numero, s.preco_centavos
     FROM alvo, assentos a
     JOIN setores s ON s.id = a.setor_id
     WHERE a.evento_id = alvo.evento_id AND a.id <> alvo.id
       AND NOT EXISTS (
         SELECT 1 FROM reservas r
         WHERE r.sessao_id = $1 AND r.assento_id = a.id
           AND (r.status = 'confirmada' OR (r.status = 'ativa' AND r.expira_em > now()))
       )
     ORDER BY a.setor_id <> alvo.setor_id,
              abs(s.preco_centavos - alvo.preco_centavos),
              CASE WHEN a.setor_id = alvo.setor_id THEN abs(ascii(a.fila) - ascii(alvo.fila)) + abs(a.numero - alvo.numero) ELSE 0 END,
              a.fila,
              abs(a.numero * 2 - (SELECT max(b.numero) + 1 FROM assentos b WHERE b.setor_id = a.setor_id))
     LIMIT 1`,
    [sessao, assentoId],
  );
  const a = rows[0];
  return a ? { id: a.id, setor: a.setor_id, nomeDoSetor: a.nome, fila: a.fila, numero: a.numero, precoCentavos: a.preco_centavos } : null;
}

export type PedidoDeReserva = { sessao: string; assentoId: string; comprador: string; chave: string };

export type ResultadoDaReserva = {
  reserva: Reserva;
  /** false quando o pedido repetiu um anterior (clique duplo) ou o assento já era desse comprador. */
  criada: boolean;
  processadaEm: string;
};

export async function reservar(banco: Banco, pedido: PedidoDeReserva): Promise<ResultadoDaReserva> {
  const comprador = pedido.comprador.trim();
  if (!comprador || comprador.length > 40) throw new ErroDeReserva("dados_invalidos", 400, "Informe um comprador de até 40 caracteres.");
  if (!/^[\w-]{8,80}$/.test(pedido.chave)) throw new ErroDeReserva("dados_invalidos", 400, "Chave do pedido inválida.");

  // Se a reserva que ocupava o assento vencer bem no meio da verificação, tenta de novo (no máximo três vezes).
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const resultado = await emTransacao(banco, async (conexao) => {
      await exigirSessao(conexao, pedido.sessao);
      const assento = await conexao.query("SELECT 1 FROM assentos WHERE id = $1 AND evento_id = $2", [pedido.assentoId, EVENTO_ID]);
      if (!assento.rowCount) throw new ErroDeReserva("assento_inexistente", 404, "Esse assento não existe.");

      await conexao.query(
        `UPDATE reservas SET status = 'expirada', atualizada_em = clock_timestamp()
         WHERE sessao_id = $1 AND assento_id = $2 AND status = 'ativa' AND expira_em <= now()`,
        [pedido.sessao, pedido.assentoId],
      );

      const inserida = await conexao.query<LinhaDaReserva>(
        `INSERT INTO reservas (sessao_id, evento_id, assento_id, comprador, status, expira_em, chave_idempotencia)
         VALUES ($1, $2, $3, $4, 'ativa', now() + make_interval(secs => $5), $6)
         ON CONFLICT DO NOTHING
         RETURNING ${COLUNAS_DA_RESERVA}`,
        [pedido.sessao, EVENTO_ID, pedido.assentoId, comprador, DURACAO_DA_RESERVA_SEGUNDOS, pedido.chave],
      );
      if (inserida.rows[0]) {
        const reserva = paraReserva(inserida.rows[0]);
        return { reserva, criada: true, processadaEm: reserva.criadaEm };
      }

      // Não inseriu: ou é o mesmo pedido repetido, ou o assento já tem dono.
      const repetida = await conexao.query<LinhaDaReserva>(
        `SELECT ${COLUNAS_DA_RESERVA} FROM reservas WHERE sessao_id = $1 AND chave_idempotencia = $2`,
        [pedido.sessao, pedido.chave],
      );
      const agora = (await conexao.query<{ agora: Date }>("SELECT clock_timestamp() AS agora")).rows[0].agora.toISOString();
      if (repetida.rows[0]) return { reserva: paraReserva(repetida.rows[0]), criada: false, processadaEm: agora };

      const dono = await conexao.query<LinhaDaReserva>(
        `SELECT ${COLUNAS_DA_RESERVA} FROM reservas
         WHERE sessao_id = $1 AND evento_id = $2 AND assento_id = $3
           AND (status = 'confirmada' OR (status = 'ativa' AND expira_em > now()))`,
        [pedido.sessao, EVENTO_ID, pedido.assentoId],
      );
      if (!dono.rows[0]) return null; // venceu nesse meio-tempo: tenta de novo
      const ocupante = paraReserva(dono.rows[0]);
      if (ocupante.comprador === comprador) return { reserva: ocupante, criada: false, processadaEm: agora };

      throw new ErroDeReserva("assento_ocupado", 409, `O assento já está ${ocupante.status === "confirmada" ? "vendido" : "reservado"}.`, {
        ocupadoPor: { comprador: ocupante.comprador, estado: ocupante.status === "confirmada" ? "vendido" : "reservado", desde: ocupante.criadaEm },
        alternativa: await buscarAlternativa(conexao, pedido.sessao, pedido.assentoId),
        processadaEm: agora,
      });
    });
    if (resultado) return resultado;
  }
  throw new ErroDeReserva("tente_de_novo", 503, "O assento mudou de estado várias vezes seguidas. Tente de novo.");
}

/** Código do ingresso de demonstração, sem letras que se confundem (0/O, 1/I). */
function gerarCodigo(): string {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const parte = (inicio: number) => Array.from(bytes.subarray(inicio, inicio + 4), (b) => letras[b % letras.length]).join("");
  return `UI-${parte(0)}-${parte(4)}`;
}

export type ResultadoDaConfirmacao = { reserva: Reserva; ingresso: Ingresso; jaConfirmada: boolean };

export async function confirmar(banco: Banco, sessao: string, reservaId: string): Promise<ResultadoDaConfirmacao> {
  if (!UUID.test(reservaId)) throw new ErroDeReserva("reserva_inexistente", 404, "Reserva não encontrada.");
  const resultado = await emTransacao(banco, async (conexao) => {
    await exigirSessao(conexao, sessao);
    const confirmada = await conexao.query<LinhaDaReserva>(
      `UPDATE reservas SET status = 'confirmada', confirmada_em = clock_timestamp(), atualizada_em = clock_timestamp()
       WHERE id = $1 AND sessao_id = $2 AND status = 'ativa' AND expira_em > now()
       RETURNING ${COLUNAS_DA_RESERVA}`,
      [reservaId, sessao],
    );
    if (confirmada.rows[0]) {
      const ingresso = await conexao.query<{ codigo: string; emitido_em: Date }>(
        "INSERT INTO ingressos (reserva_id, codigo) VALUES ($1, $2) RETURNING codigo, emitido_em",
        [reservaId, gerarCodigo()],
      );
      return {
        reserva: paraReserva(confirmada.rows[0]),
        ingresso: { codigo: ingresso.rows[0].codigo, emitidoEm: ingresso.rows[0].emitido_em.toISOString(), reservaId },
        jaConfirmada: false,
      };
    }

    const atual = await conexao.query<LinhaDaReserva & { vencida: boolean }>(
      `SELECT ${COLUNAS_DA_RESERVA}, expira_em <= now() AS vencida FROM reservas WHERE id = $1 AND sessao_id = $2`,
      [reservaId, sessao],
    );
    const linha = atual.rows[0];
    if (!linha) throw new ErroDeReserva("reserva_inexistente", 404, "Reserva não encontrada.");

    if (linha.status === "confirmada") {
      const ingresso = await conexao.query<{ codigo: string; emitido_em: Date }>(
        "SELECT codigo, emitido_em FROM ingressos WHERE reserva_id = $1",
        [reservaId],
      );
      return {
        reserva: paraReserva(linha),
        ingresso: { codigo: ingresso.rows[0].codigo, emitidoEm: ingresso.rows[0].emitido_em.toISOString(), reservaId },
        jaConfirmada: true,
      };
    }
    if (linha.status === "cancelada") throw new ErroDeReserva("reserva_cancelada", 409, "Essa reserva foi cancelada.");

    // Ativa mas vencida, ou já expirada: libera o assento (se ainda não foi) e recusa.
    await conexao.query(
      "UPDATE reservas SET status = 'expirada', atualizada_em = clock_timestamp() WHERE id = $1 AND status = 'ativa'",
      [reservaId],
    );
    return { vencida: paraReserva(linha) };
  });

  if ("vencida" in resultado) {
    throw new ErroDeReserva("reserva_vencida", 410, "O tempo da reserva acabou e o assento voltou a ficar livre.", {
      reserva: { ...resultado.vencida, status: "expirada" },
    });
  }
  return resultado;
}

/** Desistir de uma reserva ativa. */
export async function cancelar(banco: Banco, sessao: string, reservaId: string): Promise<Reserva> {
  if (!UUID.test(reservaId)) throw new ErroDeReserva("reserva_inexistente", 404, "Reserva não encontrada.");
  return emTransacao(banco, async (conexao) => {
    await exigirSessao(conexao, sessao);
    const { rows } = await conexao.query<LinhaDaReserva>(
      `UPDATE reservas SET status = 'cancelada', atualizada_em = clock_timestamp()
       WHERE id = $1 AND sessao_id = $2 AND status = 'ativa'
       RETURNING ${COLUNAS_DA_RESERVA}`,
      [reservaId, sessao],
    );
    if (rows[0]) return paraReserva(rows[0]);
    const atual = await conexao.query<LinhaDaReserva>(`SELECT ${COLUNAS_DA_RESERVA} FROM reservas WHERE id = $1 AND sessao_id = $2`, [
      reservaId,
      sessao,
    ]);
    if (!atual.rows[0]) throw new ErroDeReserva("reserva_inexistente", 404, "Reserva não encontrada.");
    if (atual.rows[0].status === "confirmada") throw new ErroDeReserva("ja_confirmada", 409, "Essa compra já foi confirmada.");
    return paraReserva(atual.rows[0]);
  });
}

/** Deixa o assento da disputa livre de novo (estorno simulado de quem ganhou a rodada anterior). */
export async function prepararDisputa(banco: Banco, sessao: string): Promise<{ assentoId: string }> {
  await emTransacao(banco, async (conexao) => {
    await exigirSessao(conexao, sessao);
    await conexao.query(
      `UPDATE reservas SET status = 'cancelada', atualizada_em = clock_timestamp()
       WHERE sessao_id = $1 AND assento_id = $2 AND status IN ('ativa', 'confirmada')`,
      [sessao, ASSENTO_DA_DISPUTA],
    );
  });
  return { assentoId: ASSENTO_DA_DISPUTA };
}
