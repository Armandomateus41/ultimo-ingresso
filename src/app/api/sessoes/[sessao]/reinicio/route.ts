import { obterBanco } from "@/servidor/banco";
import { responder } from "@/servidor/http";
import { reiniciarSessao } from "@/servidor/reservas";

/** POST /api/sessoes/:sessao/reinicio: volta o show deste visitante ao estado inicial. */
export async function POST(_request: Request, ctx: RouteContext<"/api/sessoes/[sessao]/reinicio">) {
  const { sessao } = await ctx.params;
  return responder(async () => {
    await reiniciarSessao(obterBanco(), sessao);
    return { corpo: { ok: true } };
  });
}
