/*
 * Geometria do mapa da Arena Mangue (fictícia), num quadro de 1000 × 780.
 * O banco só guarda setor, fila e número; a posição de cada assento é calculada aqui.
 */

export const LARGURA = 1000;
export const ALTURA = 780;

export type Ponto = { x: number; y: number };
export type Caixa = { x: number; y: number; largura: number; altura: number };

export const PALCO = { x: 330, y: 34, largura: 340, altura: 84 };
/** Pista em pé: trapézio na frente do palco. */
export const PISTA: Ponto[] = [
  { x: 300, y: 146 },
  { x: 700, y: 146 },
  { x: 752, y: 368 },
  { x: 248, y: 368 },
];

function girar(p: Ponto, centro: Ponto, graus: number): Ponto {
  const r = (graus * Math.PI) / 180;
  const dx = p.x - centro.x;
  const dy = p.y - centro.y;
  return { x: centro.x + dx * Math.cos(r) - dy * Math.sin(r), y: centro.y + dx * Math.sin(r) + dy * Math.cos(r) };
}

const indiceDaFila = (fila: string) => fila.charCodeAt(0) - 65; // A = 0

/** Laterais: a fila A fica colada na pista; cada fila é uma coluna, os números descem. O bloco gira para olhar o palco. */
function lateral(fila: string, numero: number, lado: "esquerda" | "direita"): Ponto {
  const f = indiceDaFila(fila);
  const sinal = lado === "esquerda" ? -1 : 1;
  const xDaFilaA = lado === "esquerda" ? 206 : 794;
  const base = { x: xDaFilaA + sinal * f * 25, y: 176 + (numero - 1) * 29 };
  const centro = { x: lado === "esquerda" ? 130 : 870, y: 280 };
  return girar(base, centro, lado === "esquerda" ? 13 : -13);
}

/** Central: 6 filas em arco atrás da pista. */
function central(fila: string, numero: number): Ponto {
  const f = indiceDaFila(fila);
  const desvio = numero - 7.5;
  return { x: 500 + desvio * 29, y: 424 + f * 28 + desvio * desvio * 0.55 };
}

/** Camarote Lua: uma fila no fundo. */
function camarote(numero: number): Ponto {
  return { x: 500 + (numero - 5.5) * 31, y: 690 };
}

export function posicaoDoAssento(setor: string, fila: string, numero: number): Ponto {
  switch (setor) {
    case "MAR":
      return lateral(fila, numero, "esquerda");
    case "SOL":
      return lateral(fila, numero, "direita");
    case "CEN":
      return central(fila, numero);
    default:
      return camarote(numero);
  }
}

export const RAIO_DO_ASSENTO = 10;

/** Caixa que envolve um conjunto de pontos, com folga. */
export function caixaDe(pontos: Ponto[], folga = 34): Caixa {
  const xs = pontos.map((p) => p.x);
  const ys = pontos.map((p) => p.y);
  const x = Math.min(...xs) - folga;
  const y = Math.min(...ys) - folga;
  return { x, y, largura: Math.max(...xs) + folga - x, altura: Math.max(...ys) + folga - y };
}

export const QUADRO_INTEIRO: Caixa = { x: 0, y: 0, largura: LARGURA, altura: ALTURA };

/** Onde fica o nome de cada setor no mapa. */
export const ROTULOS_DOS_SETORES: Record<string, Ponto & { giro: number }> = {
  MAR: { x: 92, y: 120, giro: 0 },
  SOL: { x: 908, y: 120, giro: 0 },
  CEN: { x: 500, y: 618, giro: 0 },
  CAM: { x: 500, y: 744, giro: 0 },
};
