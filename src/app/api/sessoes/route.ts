import { obterBanco } from "@/servidor/banco";
import { responder } from "@/servidor/http";
import { criarSessao } from "@/servidor/reservas";

/** POST /api/sessoes: cria um show só para este visitante. */
export async function POST() {
  return responder(async () => ({ status: 201, corpo: { sessao: await criarSessao(obterBanco()) } }));
}
