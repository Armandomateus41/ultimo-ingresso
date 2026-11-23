import { obterBanco } from "@/servidor/banco";
import { responder } from "@/servidor/http";
import { carregarMapa } from "@/servidor/reservas";

/** GET /api/sessoes/:sessao/mapa: estado de todos os assentos nesta sessão. */
export async function GET(_request: Request, ctx: RouteContext<"/api/sessoes/[sessao]/mapa">) {
  const { sessao } = await ctx.params;
  return responder(async () => ({ corpo: await carregarMapa(obterBanco(), sessao) }));
}
