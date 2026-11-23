const moeda = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export const reais = (centavos: number) => moeda.format(centavos / 100);

/** "C-08" a partir de fila e número. */
export const rotuloCurto = (fila: string, numero: number) => `${fila}-${String(numero).padStart(2, "0")}`;

/** "00:27" */
export function relogio(segundos: number) {
  const s = Math.max(0, Math.ceil(segundos));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** "21:04:12.348" no horário do navegador, para mostrar a ordem em que o servidor processou os pedidos. */
export function horaComMilissegundos(iso: string) {
  const data = new Date(iso);
  const hms = data.toLocaleTimeString("pt-BR", { hour12: false });
  return `${hms}.${String(data.getMilliseconds()).padStart(3, "0")}`;
}

export function dataDoShow(iso: string) {
  const data = new Date(iso);
  const dia = data.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short", year: "numeric", timeZone: "America/Recife" });
  const hora = data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Recife" });
  return `${dia.replace(/\./g, "")} · ${hora.replace(":", "h")}`;
}

export const milissegundos = (ms: number) => `${ms.toLocaleString("pt-BR", { maximumFractionDigits: ms < 10 ? 1 : 0 })} ms`;
