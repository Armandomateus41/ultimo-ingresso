import { obterBanco } from "@/servidor/banco";
import { responder } from "@/servidor/http";
import { prepararDisputa } from "@/servidor/reservas";

/** POST /api/sessoes/:sessao/disputa: deixa o último lugar livre de novo, para repetir a disputa. */
export async function POST(_request: Request, ctx: RouteContext<"/api/sessoes/[sessao]/disputa">) {
  const { sessao } = await ctx.params;
  return responder(async () => ({ corpo: await prepararDisputa(obterBanco(), sessao) }));
}
