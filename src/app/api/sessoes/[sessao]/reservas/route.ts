import { obterBanco } from "@/servidor/banco";
import { lerJson, responder, texto } from "@/servidor/http";
import { reservar } from "@/servidor/reservas";

/**
 * POST /api/sessoes/:sessao/reservas  { assentoId, comprador, chave }
 * 201 reserva criada · 200 pedido repetido (mesma chave) · 409 assento ocupado, com quem ocupa e uma alternativa.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/sessoes/[sessao]/reservas">) {
  const { sessao } = await ctx.params;
  const corpo = await lerJson(request);
  return responder(async () => {
    const resultado = await reservar(obterBanco(), {
      sessao,
      assentoId: texto(corpo.assentoId),
      comprador: texto(corpo.comprador),
      chave: texto(corpo.chave),
    });
    return { status: resultado.criada ? 201 : 200, corpo: resultado };
  });
}
