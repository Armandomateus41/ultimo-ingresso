import { ErroDeReserva } from "./reservas";

/** Converte o resultado de uma regra em resposta JSON; erros de regra viram o status e o código certos. */
export async function responder(trabalho: () => Promise<{ status?: number; corpo: unknown }>): Promise<Response> {
  const inicio = performance.now();
  try {
    const { status = 200, corpo } = await trabalho();
    return Response.json(corpo, { status, headers: cabecalhos(inicio) });
  } catch (erro) {
    if (erro instanceof ErroDeReserva) {
      return Response.json({ erro: erro.codigo, mensagem: erro.message, ...erro.dados }, { status: erro.status, headers: cabecalhos(inicio) });
    }
    console.error(erro);
    return Response.json({ erro: "erro_interno", mensagem: "Algo deu errado do nosso lado." }, { status: 500, headers: cabecalhos(inicio) });
  }
}

function cabecalhos(inicio: number) {
  return { "Cache-Control": "no-store", "Server-Timing": `banco;dur=${(performance.now() - inicio).toFixed(1)}` };
}

/** Lê o corpo JSON; corpo inválido vira objeto vazio (e a regra recusa com 400). */
export async function lerJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const corpo = await request.json();
    return corpo && typeof corpo === "object" ? corpo : {};
  } catch {
    return {};
  }
}

export const texto = (valor: unknown) => (typeof valor === "string" ? valor : "");
