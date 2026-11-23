import { obterBanco } from "@/servidor/banco";
import { responder } from "@/servidor/http";
import { confirmar } from "@/servidor/reservas";

/**
 * POST /api/sessoes/:sessao/reservas/:reserva/confirmacao: compra simulada, sem cobrança.
 * 201 ingresso emitido · 200 já estava confirmada (devolve o mesmo ingresso) · 410 reserva vencida.
 */
export async function POST(_request: Request, ctx: RouteContext<"/api/sessoes/[sessao]/reservas/[reserva]/confirmacao">) {
  const { sessao, reserva } = await ctx.params;
  return responder(async () => {
    const resultado = await confirmar(obterBanco(), sessao, reserva);
    return { status: resultado.jaConfirmada ? 200 : 201, corpo: resultado };
  });
}
