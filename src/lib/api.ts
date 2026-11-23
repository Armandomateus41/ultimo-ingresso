import type { Alternativa, Ingresso, Mapa, Reserva } from "@/servidor/reservas";

/** Resposta de uma chamada à API, com o tempo medido no navegador. */
export type Resposta<T> = { ok: boolean; status: number; corpo: T; inicioMs: number; fimMs: number };

export type ErroDaApi = {
  erro: string;
  mensagem: string;
  ocupadoPor?: { comprador: string; estado: "reservado" | "vendido"; desde: string };
  alternativa?: Alternativa | null;
  processadaEm?: string;
};

export type RespostaDaReserva = { reserva: Reserva; criada: boolean; processadaEm: string };
export type RespostaDaConfirmacao = { reserva: Reserva; ingresso: Ingresso; jaConfirmada: boolean };

async function chamar<T>(metodo: string, url: string, corpo?: unknown): Promise<Resposta<T>> {
  const inicioMs = performance.now();
  const resposta = await fetch(url, {
    method: metodo,
    headers: corpo ? { "Content-Type": "application/json" } : undefined,
    body: corpo ? JSON.stringify(corpo) : undefined,
    cache: "no-store",
  });
  const json = (await resposta.json().catch(() => ({ erro: "resposta_invalida", mensagem: "Resposta inválida do servidor." }))) as T;
  return { ok: resposta.ok, status: resposta.status, corpo: json, inicioMs, fimMs: performance.now() };
}

const base = (sessao: string) => `/api/sessoes/${sessao}`;

export const api = {
  criarSessao: () => chamar<{ sessao: string } & Partial<ErroDaApi>>("POST", "/api/sessoes"),
  mapa: (sessao: string) => chamar<Mapa & Partial<ErroDaApi>>("GET", `${base(sessao)}/mapa`),
  reservar: (sessao: string, assentoId: string, comprador: string, chave: string) =>
    chamar<RespostaDaReserva | ErroDaApi>("POST", `${base(sessao)}/reservas`, { assentoId, comprador, chave }),
  confirmar: (sessao: string, reservaId: string) =>
    chamar<RespostaDaConfirmacao | ErroDaApi>("POST", `${base(sessao)}/reservas/${reservaId}/confirmacao`),
  cancelar: (sessao: string, reservaId: string) => chamar<{ reserva: Reserva } | ErroDaApi>("DELETE", `${base(sessao)}/reservas/${reservaId}`),
  prepararDisputa: (sessao: string) => chamar<{ assentoId: string } | ErroDaApi>("POST", `${base(sessao)}/disputa`),
  reiniciar: (sessao: string) => chamar<{ ok: true } | ErroDaApi>("POST", `${base(sessao)}/reinicio`),
};

export const ehErro = (corpo: unknown): corpo is ErroDaApi => typeof corpo === "object" && corpo !== null && "erro" in corpo;

/** Chave de idempotência de um pedido. Repetir o mesmo pedido (clique duplo) reaproveita a chave. */
export const novaChave = () =>
  typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
