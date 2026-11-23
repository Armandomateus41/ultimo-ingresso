"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssentoNoMapa, Ingresso, Mapa, Reserva } from "@/servidor/reservas";
import { api, ehErro, novaChave, type ErroDaApi, type Resposta, type RespostaDaReserva } from "@/lib/api";
import { dataDoShow, horaComMilissegundos, milissegundos, reais, relogio, rotuloCurto } from "@/lib/formatar";
import { IngressoDigital } from "./IngressoDigital";
import { descreverEstado, Legenda, MapaDoShow, type Marcacao } from "./MapaDoShow";

const CHAVE_DA_SESSAO = "ultimo-ingresso:sessao";

type Modo = "escolher" | "disputa";

type Fluxo =
  | { etapa: "escolhendo" }
  | { etapa: "reservando" }
  | { etapa: "reservado"; reserva: Reserva }
  | { etapa: "confirmando"; reserva: Reserva }
  | { etapa: "vencida"; assentoId: string; mensagem: string }
  | { etapa: "comprado"; reserva: Reserva; ingresso: Ingresso }
  | { etapa: "ocupado"; assentoId: string; erro: ErroDaApi }
  | { etapa: "erro"; mensagem: string };

type Nome = "Ana" | "Bruno";

type Tentativa = {
  fase: "parada" | "enviando" | "ganhou" | "perdeu" | "erro";
  resposta?: Resposta<RespostaDaReserva | ErroDaApi>;
  alternativa?: { fase: "enviando" | "ok" | "recusada"; mensagem: string };
};

type Disputa = { rodada: number; executando: boolean; disparoMs?: number; tentativas: Record<Nome, Tentativa> };

const DISPUTA_INICIAL: Disputa = { rodada: 0, executando: false, tentativas: { Ana: { fase: "parada" }, Bruno: { fase: "parada" } } };

function useTelaEstreita() {
  const [estreita, setEstreita] = useState(false);
  useEffect(() => {
    const consulta = window.matchMedia("(max-width: 640px)");
    const atualizar = () => setEstreita(consulta.matches);
    atualizar();
    consulta.addEventListener("change", atualizar);
    return () => consulta.removeEventListener("change", atualizar);
  }, []);
  return estreita;
}

export function Bilheteria() {
  const [sessao, setSessao] = useState<string | null>(null);
  const [mapa, setMapa] = useState<Mapa | null>(null);
  const [desvioMs, setDesvioMs] = useState(0);
  const [modo, setModo] = useState<Modo>("escolher");
  const [foco, setFoco] = useState<string | null>(null);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [fluxo, setFluxo] = useState<Fluxo>({ etapa: "escolhendo" });
  const [disputa, setDisputa] = useState<Disputa>(DISPUTA_INICIAL);
  const [aviso, setAviso] = useState("");
  const [falha, setFalha] = useState<string | null>(null);
  // Relógio do navegador, atualizado só enquanto há reserva correndo (lido em evento, não na renderização do servidor).
  const [agora, setAgora] = useState(0);
  const chaveDoPedido = useRef<string | null>(null);
  const painelRef = useRef<HTMLDivElement>(null);
  const estreita = useTelaEstreita();

  const receberMapa = useCallback((novo: Mapa) => {
    setMapa(novo);
    setDesvioMs(Date.parse(novo.agora) - Date.now());
  }, []);

  const recarregarMapa = useCallback(async () => {
    if (!sessao) return;
    const resposta = await api.mapa(sessao);
    if (resposta.ok && !ehErro(resposta.corpo)) receberMapa(resposta.corpo);
  }, [sessao, receberMapa]);

  // Sessão: reaproveita a do navegador ou cria uma nova.
  useEffect(() => {
    let cancelado = false;
    (async () => {
      let id = localStorage.getItem(CHAVE_DA_SESSAO);
      for (let tentativa = 0; tentativa < 2; tentativa++) {
        if (!id) {
          const criada = await api.criarSessao();
          if (!criada.ok || !criada.corpo.sessao) {
            setFalha("Não foi possível abrir a bilheteria agora. Tente recarregar a página.");
            return;
          }
          id = criada.corpo.sessao;
          localStorage.setItem(CHAVE_DA_SESSAO, id);
        }
        const resposta = await api.mapa(id);
        if (cancelado) return;
        if (resposta.ok && !ehErro(resposta.corpo)) {
          setSessao(id);
          receberMapa(resposta.corpo);
          return;
        }
        if (resposta.status === 404) {
          localStorage.removeItem(CHAVE_DA_SESSAO);
          id = null;
          continue;
        }
        setFalha("Não foi possível carregar o mapa. Tente recarregar a página.");
        return;
      }
    })().catch(() => setFalha("Sem conexão com a bilheteria. Tente recarregar a página."));
    return () => {
      cancelado = true;
    };
  }, [receberMapa]);

  // Tempo real: o servidor manda o mapa sempre que alguma reserva muda.
  useEffect(() => {
    if (!sessao) return;
    const canal = new EventSource(`/api/sessoes/${sessao}/eventos`);
    canal.addEventListener("mapa", (evento) => receberMapa(JSON.parse((evento as MessageEvent).data)));
    canal.addEventListener("fim", () => {
      canal.close();
      localStorage.removeItem(CHAVE_DA_SESSAO);
      window.location.reload();
    });
    return () => canal.close();
  }, [sessao, receberMapa]);

  // Relógio da contagem regressiva.
  const temRelogio = fluxo.etapa === "reservado" || fluxo.etapa === "confirmando";
  useEffect(() => {
    if (!temRelogio) return;
    const intervalo = setInterval(() => setAgora(Date.now()), 200);
    return () => clearInterval(intervalo);
  }, [temRelogio]);

  const assentosPorId = useMemo(() => new Map((mapa?.assentos ?? []).map((a) => [a.id, a])), [mapa]);
  const setoresPorId = useMemo(() => new Map((mapa?.setores ?? []).map((s) => [s.id, s])), [mapa]);

  const reservaAtual = fluxo.etapa === "reservado" || fluxo.etapa === "confirmando" ? fluxo.reserva : null;
  const segundosRestantes = reservaAtual ? (Date.parse(reservaAtual.expiraEm) - (agora + desvioMs)) / 1000 : 0;

  // Quando o relógio zera, pede o mapa na hora (o servidor libera a reserva vencida ao ler).
  const pediuNoZero = useRef<string | null>(null);
  useEffect(() => {
    if (reservaAtual && segundosRestantes <= 0 && pediuNoZero.current !== reservaAtual.id) {
      pediuNoZero.current = reservaAtual.id;
      void recarregarMapa();
    }
  }, [reservaAtual, segundosRestantes, recarregarMapa]);

  // A reserva sumiu do mapa (venceu ou foi liberada): o painel mostra que o assento voltou para a venda.
  const reservaPerdida = useMemo(() => {
    if (fluxo.etapa !== "reservado" || !mapa) return null;
    if (Date.parse(mapa.agora) <= Date.parse(fluxo.reserva.criadaEm)) return null; // mapa anterior à reserva
    const assento = assentosPorId.get(fluxo.reserva.assentoId);
    if (!assento || assento.reservaId === fluxo.reserva.id) return null;
    return {
      etapa: "vencida" as const,
      assentoId: assento.id,
      mensagem: assento.estado === "livre" ? "O tempo acabou e o assento voltou a ficar livre no mapa." : "O tempo acabou e outra pessoa pegou o assento.",
      rotulo: rotuloCurto(assento.fila, assento.numero),
    };
  }, [mapa, fluxo, assentosPorId]);
  const fluxoVisivel: Fluxo = reservaPerdida ?? fluxo;
  const avisoVisivel = reservaPerdida ? `Tempo esgotado. O assento ${reservaPerdida.rotulo} voltou para a venda.` : aviso;

  function trocarModo(novo: Modo) {
    setModo(novo);
    setFoco(novo === "disputa" && estreita ? "CAM" : null);
  }

  function tocarAssento(assento: AssentoNoMapa) {
    const descricao = `Fila ${assento.fila}, assento ${assento.numero}: ${descreverEstado(assento, reservaAtual?.id ?? null)}.`;
    if (modo === "disputa") {
      setAviso(descricao);
      return;
    }
    if (fluxo.etapa === "reservado" || fluxo.etapa === "confirmando" || fluxo.etapa === "reservando") {
      setAviso("Você já tem uma reserva correndo. Confirme ou desista dela para escolher outro lugar.");
      return;
    }
    setSelecionado(assento.id);
    chaveDoPedido.current = null;
    setFluxo({ etapa: "escolhendo" });
    setAviso(descricao);
    if (estreita) requestAnimationFrame(() => painelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  async function reservar(assentoId = selecionado) {
    if (!sessao || !assentoId) return;
    // A mesma chave vale até a resposta chegar: um clique duplo vira o mesmo pedido.
    chaveDoPedido.current ??= novaChave();
    const chave = chaveDoPedido.current;
    setSelecionado(assentoId);
    setFluxo({ etapa: "reservando" });
    try {
      const resposta = await api.reservar(sessao, assentoId, "Você", chave);
      chaveDoPedido.current = null;
      if (resposta.ok && !ehErro(resposta.corpo)) {
        setAgora(Date.now());
        setFluxo({ etapa: "reservado", reserva: resposta.corpo.reserva });
        pediuNoZero.current = null;
        setAviso(`Assento reservado por ${mapa?.duracaoDaReservaSegundos ?? 30} segundos. Confirme a compra antes do tempo acabar.`);
      } else if (ehErro(resposta.corpo) && resposta.status === 409) {
        setFluxo({ etapa: "ocupado", assentoId, erro: resposta.corpo });
        setAviso(resposta.corpo.mensagem);
      } else {
        setFluxo({ etapa: "erro", mensagem: ehErro(resposta.corpo) ? resposta.corpo.mensagem : "Não deu para reservar." });
      }
    } catch {
      chaveDoPedido.current = null;
      setFluxo({ etapa: "erro", mensagem: "Sem conexão. Tente de novo." });
    }
    void recarregarMapa();
  }

  async function confirmarCompra() {
    if (!sessao || fluxo.etapa !== "reservado") return;
    const reserva = fluxo.reserva;
    setFluxo({ etapa: "confirmando", reserva });
    const resposta = await api.confirmar(sessao, reserva.id);
    if (resposta.ok && !ehErro(resposta.corpo)) {
      setFluxo({ etapa: "comprado", reserva: resposta.corpo.reserva, ingresso: resposta.corpo.ingresso });
      setAviso(`Compra confirmada. Ingresso ${resposta.corpo.ingresso.codigo} emitido.`);
    } else if (resposta.status === 410) {
      setFluxo({ etapa: "vencida", assentoId: reserva.assentoId, mensagem: "A confirmação chegou depois do prazo. O assento voltou a ficar livre." });
      setAviso("A reserva venceu antes da confirmação.");
    } else {
      setFluxo({ etapa: "erro", mensagem: ehErro(resposta.corpo) ? resposta.corpo.mensagem : "Não deu para confirmar." });
    }
    void recarregarMapa();
  }

  async function desistir() {
    if (!sessao || fluxo.etapa !== "reservado") return;
    await api.cancelar(sessao, fluxo.reserva.id);
    setFluxo({ etapa: "escolhendo" });
    setAviso("Reserva cancelada. O assento voltou para a venda.");
    void recarregarMapa();
  }

  async function disputar() {
    if (!sessao || !mapa || disputa.executando) return;
    const alvo = mapa.assentoDaDisputa;
    setDisputa((d) => ({ rodada: d.rodada + 1, executando: true, tentativas: { Ana: { fase: "enviando" }, Bruno: { fase: "enviando" } } }));
    setAviso("Ana e Bruno pediram o mesmo assento ao mesmo tempo.");
    try {
      await api.prepararDisputa(sessao);
      // Duas requisições independentes, disparadas no mesmo instante. Quem decide é o banco.
      // A ordem de saída é sorteada: senão o pedido escrito primeiro levaria sempre a vantagem de microssegundos.
      const ordem: Nome[] = Math.random() < 0.5 ? ["Ana", "Bruno"] : ["Bruno", "Ana"];
      const pedidos = Object.fromEntries(ordem.map((nome) => [nome, api.reservar(sessao, alvo, nome, novaChave())])) as Record<
        Nome,
        Promise<Resposta<RespostaDaReserva | ErroDaApi>>
      >;
      const [ana, bruno] = await Promise.all([pedidos.Ana, pedidos.Bruno]);
      const fase = (r: Resposta<RespostaDaReserva | ErroDaApi>): Tentativa["fase"] => (r.ok ? "ganhou" : r.status === 409 ? "perdeu" : "erro");
      setDisputa((d) => ({
        ...d,
        executando: false,
        disparoMs: Math.abs(bruno.inicioMs - ana.inicioMs),
        tentativas: { Ana: { fase: fase(ana), resposta: ana }, Bruno: { fase: fase(bruno), resposta: bruno } },
      }));
      const vencedor = ana.ok ? "Ana" : bruno.ok ? "Bruno" : null;
      setAviso(vencedor ? `${vencedor} ficou com o último lugar. ${vencedor === "Ana" ? "Bruno" : "Ana"} recebeu uma alternativa.` : "Nenhum dos dois conseguiu.");
    } catch {
      setDisputa((d) => ({ ...d, executando: false, tentativas: { Ana: { fase: "erro" }, Bruno: { fase: "erro" } } }));
    }
    void recarregarMapa();
  }

  async function reservarAlternativa(nome: Nome, assentoId: string) {
    if (!sessao) return;
    const atualizar = (alternativa: Tentativa["alternativa"]) =>
      setDisputa((d) => ({ ...d, tentativas: { ...d.tentativas, [nome]: { ...d.tentativas[nome], alternativa } } }));
    atualizar({ fase: "enviando", mensagem: "Enviando…" });
    const resposta = await api.reservar(sessao, assentoId, nome, novaChave());
    if (resposta.ok) {
      atualizar({ fase: "ok", mensagem: `${resposta.status} · reservado para ${nome}.` });
      setAviso(`Alternativa reservada para ${nome}.`);
    } else {
      atualizar({ fase: "recusada", mensagem: `${resposta.status} · ${ehErro(resposta.corpo) ? resposta.corpo.mensagem : "recusado"}` });
    }
    void recarregarMapa();
  }

  async function reiniciar() {
    if (!sessao) return;
    await api.reiniciar(sessao);
    setFluxo({ etapa: "escolhendo" });
    setSelecionado(null);
    setDisputa(DISPUTA_INICIAL);
    setAviso("Mapa reiniciado.");
    void recarregarMapa();
  }

  const marcacoes = useMemo(() => {
    const m: Record<string, Marcacao> = {};
    if (!mapa) return m;
    if (modo === "disputa") {
      m[mapa.assentoDaDisputa] = "disputa";
      for (const tentativa of Object.values(disputa.tentativas)) {
        const corpo = tentativa.resposta?.corpo;
        if (corpo && ehErro(corpo) && corpo.alternativa) m[corpo.alternativa.id] = "alternativa";
      }
    } else if (fluxo.etapa === "ocupado" && fluxo.erro.alternativa) {
      m[fluxo.erro.alternativa.id] = "alternativa";
    }
    return m;
  }, [mapa, modo, disputa, fluxo]);

  const minhaReservaId = fluxo.etapa === "reservado" || fluxo.etapa === "confirmando" || fluxo.etapa === "comprado" ? fluxo.reserva.id : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <Cabecalho mapa={mapa} aoReiniciar={reiniciar} />

      <main className="mx-auto w-full max-w-[1240px] flex-1 px-3 pb-10 sm:px-5">
        <ModoDeUso modo={modo} aoTrocar={trocarModo} />

        {falha ? (
          <p role="alert" className="mt-4 rounded-md border-2 border-vermelho bg-white p-4 font-semibold text-vermelho-texto">
            {falha}
          </p>
        ) : (
          <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
            <section aria-label="Mapa do show" className="relative min-w-0 overflow-hidden rounded-md border-2 border-tinta bg-[#fbf6ec]">
              {/* No celular, com o mapa inteiro, a altura acompanha o desenho; com um setor aproximado, o mapa cresce. */}
              <div className={foco || !estreita ? "h-[56dvh] min-h-[380px] sm:h-[min(620px,64dvh)]" : "h-[calc(86vw+56px)]"}>
                {mapa ? (
                  <MapaDoShow
                    assentos={mapa.assentos}
                    setores={mapa.setores}
                    selecionado={modo === "escolher" ? (reservaAtual?.assentoId ?? selecionado) : null}
                    minhaReservaId={minhaReservaId}
                    marcacoes={marcacoes}
                    foco={foco}
                    aoMudarFoco={setFoco}
                    aoTocarAssento={tocarAssento}
                  />
                ) : (
                  <div className="grid h-full place-items-center text-tinta-suave" aria-busy="true">
                    Abrindo a bilheteria…
                  </div>
                )}
              </div>
              <div className="border-t-2 border-tinta px-3 py-2.5">
                <Legenda comDisputa={modo === "disputa"} />
              </div>
              {reservaAtual && modo === "escolher" && (
                // No celular o painel fica abaixo do mapa: o relógio aparece também aqui, para ver o assento e o tempo juntos.
                <p
                  aria-hidden="true"
                  className="absolute top-14 right-2 rounded-md border-2 border-tinta bg-mostarda px-2.5 py-1 font-mono text-sm font-semibold tabular-nums lg:hidden"
                >
                  Sua reserva · {relogio(segundosRestantes)}
                </p>
              )}
            </section>

            <div ref={painelRef} className="min-w-0 scroll-mt-3 lg:sticky lg:top-4">
              {mapa &&
                (modo === "escolher" ? (
                  <PainelDeEscolha
                    mapa={mapa}
                    fluxo={fluxoVisivel}
                    selecionado={selecionado ? (assentosPorId.get(selecionado) ?? null) : null}
                    assentosPorId={assentosPorId}
                    setoresPorId={setoresPorId}
                    segundosRestantes={segundosRestantes}
                    aoReservar={() => reservar()}
                    aoConfirmar={confirmarCompra}
                    aoDesistir={desistir}
                    aoReservarOutro={(id) => {
                      chaveDoPedido.current = null;
                      void reservar(id);
                    }}
                    aoRecomecar={() => {
                      setFluxo({ etapa: "escolhendo" });
                      setSelecionado(null);
                    }}
                  />
                ) : (
                  <PainelDaDisputa mapa={mapa} disputa={disputa} assentosPorId={assentosPorId} aoDisputar={disputar} aoReservarAlternativa={reservarAlternativa} />
                ))}
            </div>
          </div>
        )}

        <p aria-live="polite" className="sr-only">
          {avisoVisivel}
        </p>

        <ComoFunciona />
      </main>

      <footer className="border-t-2 border-tinta bg-tinta px-4 py-5 text-sm text-papel">
        <div className="mx-auto flex max-w-[1240px] flex-wrap items-center justify-between gap-3">
          <p>
            <span className="titulo-cartaz mr-2 text-base">
              Último <span className="text-mostarda">Ingresso</span>
            </span>
            Ingressos com lugar marcado.
          </p>
          <p className="text-papel/80">Nenhum pagamento é processado nesta página.</p>
        </div>
      </footer>
    </div>
  );
}

function Cabecalho({ mapa, aoReiniciar }: { mapa: Mapa | null; aoReiniciar: () => void }) {
  return (
    <header className="border-b-2 border-tinta">
      <div className="bg-tinta text-papel">
        <div className="mx-auto flex max-w-[1240px] items-center justify-between gap-3 px-3 py-2 sm:px-5">
          <p className="titulo-cartaz text-xl tracking-wide">
            Último <span className="text-mostarda">Ingresso</span>
          </p>
          <div className="flex items-center gap-3">
            <button type="button" onClick={aoReiniciar} className="rounded-md border border-papel/40 px-2.5 py-1 text-sm font-semibold hover:bg-papel hover:text-tinta">
              Reiniciar
            </button>
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-[1240px] px-3 pt-3 pb-3 sm:px-5 sm:pt-5 sm:pb-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div>
            <p className="etiqueta-mono text-xs text-vermelho-texto sm:text-[0.8125rem]">{mapa ? `${mapa.evento.local} · ${mapa.evento.cidade}` : "Arena Mangue · Recife, PE"}</p>
            <h1 className="titulo-cartaz mt-1 text-[clamp(2.15rem,9.4vw,4.6rem)]">
              {mapa?.evento.artista ?? "Lia Brasa & Banda Cometa"}
            </h1>
          </div>
          <div className="flex items-center gap-3 whitespace-nowrap pb-1">
            <span className="titulo-cartaz -rotate-2 rounded-md bg-mostarda px-2.5 py-1 text-xl text-tinta sm:text-3xl">
              {mapa?.evento.turne ?? "Turnê Cais"}
            </span>
            <span className="etiqueta-mono text-xs font-semibold sm:text-[0.8125rem]">{mapa ? dataDoShow(mapa.evento.aconteceEm) : ""}</span>
          </div>
        </div>
      </div>
    </header>
  );
}

function ModoDeUso({ modo, aoTrocar }: { modo: Modo; aoTrocar: (m: Modo) => void }) {
  const opcoes: { id: Modo; titulo: string; detalhe: string }[] = [
    { id: "escolher", titulo: "Escolher meu lugar", detalhe: "Reserve e veja o tempo correr" },
    { id: "disputa", titulo: "Disputar o último lugar", detalhe: "Ana e Bruno, ao mesmo tempo" },
  ];
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:mt-4 sm:gap-3" role="group" aria-label="Como você quer experimentar">
      {opcoes.map((opcao) => {
        const ativo = opcao.id === modo;
        return (
          <button
            key={opcao.id}
            type="button"
            aria-pressed={ativo}
            onClick={() => aoTrocar(opcao.id)}
            className={`rounded-md border-2 border-tinta px-3 py-2 text-left transition-colors sm:px-4 sm:py-3 ${
              ativo ? "bg-vermelho text-white" : "bg-[#fbf6ec] hover:bg-papel-2"
            }`}
          >
            <span className="titulo-cartaz block text-[1.2rem] leading-[0.95] sm:text-[1.9rem]">{opcao.titulo}</span>
            <span className={`mt-1 block text-[0.72rem] leading-tight font-medium sm:text-sm ${ativo ? "text-white/90" : "text-tinta-suave"}`}>{opcao.detalhe}</span>
          </button>
        );
      })}
    </div>
  );
}

type PropsDaEscolha = {
  mapa: Mapa;
  fluxo: Fluxo;
  selecionado: AssentoNoMapa | null;
  assentosPorId: Map<string, AssentoNoMapa>;
  setoresPorId: Map<string, { id: string; nome: string; precoCentavos: number }>;
  segundosRestantes: number;
  aoReservar: () => void;
  aoConfirmar: () => void;
  aoDesistir: () => void;
  aoReservarOutro: (assentoId: string) => void;
  aoRecomecar: () => void;
};

function Cartao({ children, titulo }: { children: React.ReactNode; titulo: string }) {
  return (
    <section className="aparecer rounded-md border-2 border-tinta bg-[#fbf6ec]" aria-label={titulo}>
      <h2 className="titulo-cartaz border-b-2 border-tinta px-4 py-2.5 text-2xl">{titulo}</h2>
      <div className="p-4">{children}</div>
    </section>
  );
}

function FichaDoAssento({ assento, setor }: { assento: AssentoNoMapa; setor?: { nome: string; precoCentavos: number } }) {
  return (
    <dl className="grid grid-cols-[1fr_auto_auto] items-end gap-x-4 border-b-2 border-dashed border-tinta/40 pb-3">
      <div>
        <dt className="text-xs font-semibold text-tinta-suave">Setor</dt>
        <dd className="titulo-cartaz text-2xl">{setor?.nome ?? assento.setor}</dd>
      </div>
      <div className="text-center">
        <dt className="text-xs font-semibold text-tinta-suave">Fila</dt>
        <dd className="titulo-cartaz text-3xl">{assento.fila}</dd>
      </div>
      <div className="text-center">
        <dt className="text-xs font-semibold text-tinta-suave">Assento</dt>
        <dd className="titulo-cartaz text-3xl">{String(assento.numero).padStart(2, "0")}</dd>
      </div>
      {setor && (
        <div className="col-span-3 mt-2 flex items-baseline justify-between">
          <dt className="text-sm text-tinta-suave">Valor</dt>
          <dd className="font-mono text-lg font-semibold">{reais(setor.precoCentavos)}</dd>
        </div>
      )}
    </dl>
  );
}

function PainelDeEscolha(props: PropsDaEscolha) {
  const { mapa, fluxo, selecionado, assentosPorId, setoresPorId, segundosRestantes } = props;
  const duracao = mapa.duracaoDaReservaSegundos;

  if (fluxo.etapa === "comprado") {
    const assento = assentosPorId.get(fluxo.reserva.assentoId);
    const setor = assento ? setoresPorId.get(assento.setor) : undefined;
    return (
      <div className="space-y-3">
        {assento && setor && (
          <IngressoDigital
            evento={mapa.evento}
            ingresso={fluxo.ingresso}
            nomeDoSetor={setor.nome}
            fila={assento.fila}
            numero={assento.numero}
            precoCentavos={setor.precoCentavos}
          />
        )}
        <p className="text-sm text-tinta-suave">O assento aparece como comprado por você no mapa. Para comprar de novo, escolha outro lugar.</p>
        <button type="button" className="botao botao-papel w-full" onClick={props.aoRecomecar}>
          Escolher outro lugar
        </button>
      </div>
    );
  }

  if (fluxo.etapa === "reservado" || fluxo.etapa === "confirmando") {
    const assento = assentosPorId.get(fluxo.reserva.assentoId);
    const proporcao = Math.max(0, Math.min(1, segundosRestantes / duracao));
    const urgente = segundosRestantes <= 10;
    return (
      <Cartao titulo="Reservado para você">
        {assento && <FichaDoAssento assento={assento} setor={setoresPorId.get(assento.setor)} />}
        <div className="mt-4" role="timer" aria-label={`Tempo restante da reserva: ${Math.max(0, Math.ceil(segundosRestantes))} segundos`}>
          <div className="flex items-baseline justify-between">
            <span className="text-sm font-semibold">Tempo para confirmar</span>
            <span className={`font-mono text-4xl font-semibold tabular-nums ${urgente ? "text-vermelho-texto" : ""}`} aria-hidden="true">
              {relogio(segundosRestantes)}
            </span>
          </div>
          <div className="mt-2 h-3 overflow-hidden rounded-sm border-2 border-tinta bg-papel" aria-hidden="true">
            <div className={`h-full ${urgente ? "bg-vermelho" : "bg-tinta"}`} style={{ width: `${proporcao * 100}%`, transition: "width 0.2s linear" }} />
          </div>
          <p className="mt-2 text-sm text-tinta-suave">Se o tempo acabar, o assento volta para o mapa sozinho. Pode deixar correr para ver.</p>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
          <button type="button" className="botao botao-vermelho" onClick={props.aoConfirmar} disabled={fluxo.etapa === "confirmando"}>
            {fluxo.etapa === "confirmando" ? "Confirmando…" : "Confirmar compra"}
          </button>
          <button type="button" className="botao botao-papel" onClick={props.aoDesistir} disabled={fluxo.etapa === "confirmando"}>
            Desistir
          </button>
        </div>
      </Cartao>
    );
  }

  if (fluxo.etapa === "vencida") {
    const assento = assentosPorId.get(fluxo.assentoId);
    return (
      <Cartao titulo="Tempo esgotado">
        <p className="font-semibold">{fluxo.mensagem}</p>
        {assento && (
          <p className="mt-2 text-sm text-tinta-suave">
            Assento {rotuloCurto(assento.fila, assento.numero)} agora está <strong className="text-tinta">{descreverEstado(assento, null)}</strong>. Ninguém foi cobrado.
          </p>
        )}
        <div className="mt-4 grid gap-2">
          {assento?.estado === "livre" && (
            <button type="button" className="botao botao-tinta" onClick={() => props.aoReservarOutro(assento.id)}>
              Reservar de novo
            </button>
          )}
          <button type="button" className="botao botao-papel" onClick={props.aoRecomecar}>
            Escolher outro lugar
          </button>
        </div>
      </Cartao>
    );
  }

  if (fluxo.etapa === "ocupado") {
    const alternativa = fluxo.erro.alternativa;
    return (
      <Cartao titulo="Alguém chegou antes">
        <p className="font-semibold">
          {fluxo.erro.mensagem} {fluxo.erro.ocupadoPor ? `Quem está com ele: ${fluxo.erro.ocupadoPor.comprador}.` : ""}
        </p>
        {alternativa && (
          <div className="mt-3 rounded-md border-2 border-dashed border-verde p-3">
            <p className="text-sm text-tinta-suave">O servidor sugeriu este lugar livre:</p>
            <p className="titulo-cartaz mt-1 text-2xl">
              {alternativa.nomeDoSetor} · {rotuloCurto(alternativa.fila, alternativa.numero)}
            </p>
            <p className="font-mono text-sm">{reais(alternativa.precoCentavos)}</p>
            <button type="button" className="botao botao-tinta mt-3 w-full" onClick={() => props.aoReservarOutro(alternativa.id)}>
              Reservar a alternativa
            </button>
          </div>
        )}
        <button type="button" className="botao botao-papel mt-2 w-full" onClick={props.aoRecomecar}>
          Escolher no mapa
        </button>
      </Cartao>
    );
  }

  if (!selecionado) {
    const livres = mapa.assentos.filter((a) => a.estado === "livre").length;
    return (
      <Cartao titulo="Escolha um lugar">
        <p>
          Toque num <strong>assento livre</strong> (círculo vazio). Você reserva por {duracao} segundos e decide se confirma a compra
          ou deixa o tempo acabar.
        </p>
        <p className="etiqueta-mono mt-3 text-tinta-suave">
          {livres} lugares livres agora · o mapa muda sozinho quando outras reservas vencem
        </p>
        <ul className="mt-4 divide-y-2 divide-dashed divide-tinta/30 border-y-2 border-tinta">
          {mapa.setores.map((s) => (
            <li key={s.id} className="flex items-baseline justify-between py-2">
              <span className="font-semibold">{s.nome}</span>
              <span className="font-mono text-sm">{reais(s.precoCentavos)}</span>
            </li>
          ))}
        </ul>
      </Cartao>
    );
  }

  const setor = setoresPorId.get(selecionado.setor);
  const livre = selecionado.estado === "livre";
  return (
    <Cartao titulo={livre ? "Lugar escolhido" : "Lugar indisponível"}>
      <FichaDoAssento assento={selecionado} setor={setor} />
      <p className="mt-3 text-sm">
        Situação: <strong>{descreverEstado(selecionado, null)}</strong>
        {selecionado.estado === "reservado" && selecionado.expiraEm ? ". Se ninguém confirmar, ele volta para a venda." : "."}
      </p>
      {fluxo.etapa === "erro" && (
        <p role="alert" className="mt-2 font-semibold text-vermelho-texto">
          {fluxo.mensagem}
        </p>
      )}
      <button type="button" className="botao botao-tinta mt-4 w-full" onClick={props.aoReservar} disabled={!livre || fluxo.etapa === "reservando"}>
        {fluxo.etapa === "reservando" ? "Reservando…" : livre ? `Reservar por ${duracao} segundos` : "Escolha um assento livre"}
      </button>
    </Cartao>
  );
}

type PropsDaDisputa = {
  mapa: Mapa;
  disputa: Disputa;
  assentosPorId: Map<string, AssentoNoMapa>;
  aoDisputar: () => void;
  aoReservarAlternativa: (nome: Nome, assentoId: string) => void;
};

function PainelDaDisputa({ mapa, disputa, assentosPorId, aoDisputar, aoReservarAlternativa }: PropsDaDisputa) {
  const alvo = assentosPorId.get(mapa.assentoDaDisputa);
  const jaRodou = disputa.rodada > 0 && !disputa.executando;
  const tentativas = (["Ana", "Bruno"] as const).map((nome) => ({ nome, ...disputa.tentativas[nome] }));
  const vencedora = tentativas.find((t) => t.fase === "ganhou");
  const horaDaVitoria = vencedora?.resposta && !ehErro(vencedora.resposta.corpo) ? Date.parse(vencedora.resposta.corpo.processadaEm) : null;

  return (
    <Cartao titulo="O último lugar do camarote">
      <p>
        Ana e Bruno querem o mesmo lugar: <strong>Camarote Lua, fila {alvo?.fila ?? "A"}, assento {alvo?.numero ?? 7}</strong>, o único que sobrou.
        O botão abaixo dispara os dois pedidos ao mesmo tempo, em requisições separadas. Quem decide é o banco de dados.
      </p>

      <button type="button" className="botao botao-vermelho mt-4 w-full" onClick={aoDisputar} disabled={disputa.executando}>
        {disputa.executando ? "Disparando…" : jaRodou ? "Repetir a disputa" : "Disparar as duas compras"}
      </button>
      {jaRodou && disputa.disparoMs !== undefined && (
        <p className="etiqueta-mono mt-2 text-tinta-suave">
          Rodada {disputa.rodada} · pedidos saíram com {milissegundos(disputa.disparoMs)} de diferença
        </p>
      )}

      <ol className="mt-4 grid gap-3">
        {tentativas.map((t) => {
          const corpo = t.resposta?.corpo;
          const erro = corpo && ehErro(corpo) ? corpo : null;
          const ok = corpo && !ehErro(corpo) ? corpo : null;
          const processadaEm = ok?.processadaEm ?? erro?.processadaEm;
          const atraso = processadaEm && horaDaVitoria && t.fase === "perdeu" ? Date.parse(processadaEm) - horaDaVitoria : null;
          const cor = t.nome === "Ana" ? "bg-vermelho" : "bg-verde";
          return (
            <li key={t.nome} className="rounded-md border-2 border-tinta bg-white/60" aria-live="polite">
              <div className="flex items-center justify-between gap-2 border-b-2 border-tinta px-3 py-2">
                <span className="flex items-center gap-2">
                  <span className={`grid size-7 place-items-center rounded-full ${cor} text-sm font-extrabold text-white`} aria-hidden="true">
                    {t.nome[0]}
                  </span>
                  <span className="titulo-cartaz text-2xl">{t.nome}</span>
                </span>
                <Selo fase={t.fase} />
              </div>
              <div className="space-y-1.5 px-3 py-2.5 text-sm">
                {t.fase === "parada" && <p className="text-tinta-suave">Esperando o disparo.</p>}
                {t.fase === "enviando" && <p className="text-tinta-suave">Pedido a caminho do servidor…</p>}
                {t.resposta && (
                  <p className="etiqueta-mono">
                    POST /reservas → {t.resposta.status} {t.resposta.status === 201 ? "Created" : t.resposta.status === 409 ? "Conflict" : ""} ·{" "}
                    {milissegundos(t.resposta.fimMs - t.resposta.inicioMs)}
                  </p>
                )}
                {processadaEm && <p className="etiqueta-mono text-tinta-suave">servidor decidiu às {horaComMilissegundos(processadaEm)}</p>}
                {t.fase === "ganhou" && <p className="font-semibold">Ficou com o lugar. A reserva vale {mapa.duracaoDaReservaSegundos} segundos.</p>}
                {t.fase === "perdeu" && erro && (
                  <>
                    <p className="font-semibold">
                      Recusado: o assento já estava com {erro.ocupadoPor?.comprador ?? "outra pessoa"}
                      {atraso !== null && atraso >= 0 ? `, que chegou ${milissegundos(atraso)} antes no banco` : ""}.
                    </p>
                    {erro.alternativa && (
                      <div className="mt-2 rounded-md border-2 border-dashed border-verde p-2.5">
                        <p className="text-tinta-suave">Alternativa que o servidor devolveu:</p>
                        <p className="titulo-cartaz text-xl">
                          {erro.alternativa.nomeDoSetor} · {rotuloCurto(erro.alternativa.fila, erro.alternativa.numero)} ·{" "}
                          <span className="font-mono text-base font-semibold normal-case">{reais(erro.alternativa.precoCentavos)}</span>
                        </p>
                        {t.alternativa ? (
                          <p className={`mt-1 font-semibold ${t.alternativa.fase === "recusada" ? "text-vermelho-texto" : ""}`}>{t.alternativa.mensagem}</p>
                        ) : (
                          <button
                            type="button"
                            className="botao botao-tinta mt-2 min-h-10 w-full text-sm"
                            onClick={() => aoReservarAlternativa(t.nome, erro.alternativa!.id)}
                          >
                            Reservar a alternativa para {t.nome}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
                {t.fase === "erro" && <p className="font-semibold text-vermelho-texto">Falhou antes de chegar ao banco. Tente de novo.</p>}
              </div>
            </li>
          );
        })}
      </ol>

      {jaRodou && (
        <p className="mt-3 text-sm text-tinta-suave">
          Repita quantas vezes quiser: às vezes ganha a Ana, às vezes o Bruno, mas nunca os dois. A disputa acontece só no seu show; outros
          visitantes têm o deles.
        </p>
      )}
    </Cartao>
  );
}

function Selo({ fase }: { fase: Tentativa["fase"] }) {
  if (fase === "ganhou")
    return <span className="carimbo rounded-md border-2 border-verde px-2 py-0.5 text-sm font-extrabold text-verde uppercase">Conseguiu</span>;
  if (fase === "perdeu")
    return (
      <span className="carimbo rounded-md border-2 border-vermelho-texto px-2 py-0.5 text-sm font-extrabold text-vermelho-texto uppercase">Não conseguiu</span>
    );
  if (fase === "erro") return <span className="text-sm font-bold text-vermelho-texto">Erro</span>;
  return null;
}

function ComoFunciona() {
  return (
    <section aria-labelledby="como-funciona" className="mt-10 border-t-2 border-tinta pt-6">
      <h2 id="como-funciona" className="titulo-cartaz text-4xl">
        Como o banco decide
      </h2>
      <div className="mt-4 grid gap-5 md:grid-cols-3 [&>div]:min-w-0">
        <div>
          <h3 className="text-lg font-bold">Uma reserva válida por assento</h3>
          <p className="mt-1 text-[0.95rem] leading-relaxed">
            Um índice único parcial no PostgreSQL só aceita uma reserva ativa ou confirmada por assento, sessão e evento. Quando Ana e Bruno
            inserem ao mesmo tempo, o segundo espera o primeiro dentro do banco e não grava nada.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md bg-tinta p-3 font-mono text-[0.78rem] leading-relaxed text-papel">
{`CREATE UNIQUE INDEX ...
  ON reservas (sessao_id, evento_id, assento_id)
  WHERE status IN ('ativa', 'confirmada');`}
          </pre>
        </div>
        <div>
          <h3 className="text-lg font-bold">Clique duplo e confirmação dupla</h3>
          <p className="mt-1 text-[0.95rem] leading-relaxed">
            Cada pedido leva uma chave; repetir a chave devolve a mesma reserva. Confirmar troca o status com
            <code className="mx-1 font-mono text-sm">WHERE status = &apos;ativa&apos;</code>, e o ingresso tem uma linha só por reserva: a segunda
            confirmação recebe o mesmo ingresso.
          </p>
        </div>
        <div>
          <h3 className="text-lg font-bold">Tempo esgotado</h3>
          <p className="mt-1 text-[0.95rem] leading-relaxed">
            A reserva vence pelo relógio do banco. Antes de cada tentativa e a cada leitura do mapa, as vencidas viram &quot;expiradas&quot; e saem
            do índice. Confirmar depois do prazo devolve 410 e libera o lugar.
          </p>
        </div>
      </div>
    </section>
  );
}
