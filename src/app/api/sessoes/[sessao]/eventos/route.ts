import { obterBanco } from "@/servidor/banco";
import { assinaturaDaSessao, carregarMapa, ErroDeReserva, expirarVencidas } from "@/servidor/reservas";

/** Em plataformas serverless, a função pode ficar aberta até 5 minutos (o canal fecha antes, em 4). */
export const maxDuration = 300;

const INTERVALO_MS = 700;
/** O canal fecha depois de alguns minutos; o EventSource do navegador reconecta sozinho. */
const DURACAO_MAXIMA_MS = 4 * 60_000;

/**
 * GET /api/sessoes/:sessao/eventos: canal de tempo real (Server-Sent Events).
 *
 * A cada 700 ms: libera as reservas vencidas da sessão e compara a assinatura do estado (quantidade de
 * reservas e última alteração). Quando muda, manda o mapa inteiro. Não depende de processo em segundo
 * plano nem de LISTEN/NOTIFY, então funciona igual em contêiner e em plataforma serverless.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/sessoes/[sessao]/eventos">) {
  const { sessao } = await ctx.params;
  const banco = obterBanco();

  try {
    await assinaturaDaSessao(banco, sessao).then(() => carregarMapa(banco, sessao));
  } catch (erro) {
    if (erro instanceof ErroDeReserva) return Response.json({ erro: erro.codigo, mensagem: erro.message }, { status: erro.status });
    throw erro;
  }

  const codificador = new TextEncoder();
  let ativo = true;
  request.signal.addEventListener("abort", () => {
    ativo = false;
  });

  const fluxo = new ReadableStream({
    async start(controle) {
      const escrever = (texto: string) => {
        if (ativo) controle.enqueue(codificador.encode(texto));
      };
      escrever("retry: 1500\n\n");

      let ultimaAssinatura = "";
      let ultimoEnvio = Date.now();
      const inicio = Date.now();
      while (ativo && Date.now() - inicio < DURACAO_MAXIMA_MS) {
        try {
          await expirarVencidas(banco, sessao);
          const assinatura = await assinaturaDaSessao(banco, sessao);
          if (assinatura !== ultimaAssinatura) {
            ultimaAssinatura = assinatura;
            escrever(`event: mapa\ndata: ${JSON.stringify(await carregarMapa(banco, sessao))}\n\n`);
            ultimoEnvio = Date.now();
          } else if (Date.now() - ultimoEnvio > 15_000) {
            escrever(": ainda aqui\n\n");
            ultimoEnvio = Date.now();
          }
        } catch (erro) {
          if (erro instanceof ErroDeReserva) {
            escrever(`event: fim\ndata: ${JSON.stringify({ erro: erro.codigo })}\n\n`);
            break;
          }
          console.error("[eventos]", erro);
        }
        await new Promise((resolver) => setTimeout(resolver, INTERVALO_MS));
      }
      ativo = false;
      try {
        controle.close();
      } catch {
        // o navegador já fechou a conexão
      }
    },
    cancel() {
      ativo = false;
    },
  });

  return new Response(fluxo, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
