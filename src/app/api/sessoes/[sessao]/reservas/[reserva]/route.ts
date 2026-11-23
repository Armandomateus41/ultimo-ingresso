import { obterBanco } from "@/servidor/banco";
import { responder } from "@/servidor/http";
import { cancelar } from "@/servidor/reservas";

/** DELETE /api/sessoes/:sessao/reservas/:reserva: desiste de uma reserva ativa e libera o assento. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/sessoes/[sessao]/reservas/[reserva]">) {
  const { sessao, reserva } = await ctx.params;
  return responder(async () => ({ corpo: { reserva: await cancelar(obterBanco(), sessao, reserva) } }));
}
