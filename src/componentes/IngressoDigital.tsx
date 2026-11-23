import type { Evento, Ingresso } from "@/servidor/reservas";
import { dataDoShow, reais } from "@/lib/formatar";

type Props = {
  evento: Evento;
  ingresso: Ingresso;
  nomeDoSetor: string;
  fila: string;
  numero: number;
  precoCentavos: number;
};

/** Desenho de código de barras 2D só para compor o ingresso: vem do código, mas não é um QR de verdade. */
function Codigo2D({ codigo }: { codigo: string }) {
  const tamanho = 17;
  let semente = 0;
  for (const letra of codigo) semente = (semente * 31 + letra.charCodeAt(0)) >>> 0;
  const proximo = () => {
    semente ^= semente << 13;
    semente ^= semente >>> 17;
    semente ^= semente << 5;
    return (semente >>> 0) / 4294967296;
  };
  const canto = (x: number, y: number) => (x < 4 && y < 4) || (x > tamanho - 5 && y < 4) || (x < 4 && y > tamanho - 5);
  const celulas: { x: number; y: number }[] = [];
  for (let y = 0; y < tamanho; y++) for (let x = 0; x < tamanho; x++) if (!canto(x, y) && proximo() > 0.52) celulas.push({ x, y });
  const marcador = (x: number, y: number) => (
    <g key={`${x}-${y}`}>
      <rect x={x} y={y} width="4" height="4" fill="#1c1730" />
      <rect x={x + 0.7} y={y + 0.7} width="2.6" height="2.6" fill="#fbf6ec" />
      <rect x={x + 1.3} y={y + 1.3} width="1.4" height="1.4" fill="#1c1730" />
    </g>
  );
  return (
    <svg viewBox={`-1 -1 ${tamanho + 2} ${tamanho + 2}`} className="size-24 shrink-0" role="img" aria-label="Código do ingresso">
      <rect x="-1" y="-1" width={tamanho + 2} height={tamanho + 2} fill="#fbf6ec" />
      {celulas.map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width="1" height="1" fill="#1c1730" />
      ))}
      {marcador(0, 0)}
      {marcador(tamanho - 4, 0)}
      {marcador(0, tamanho - 4)}
    </svg>
  );
}

export function IngressoDigital({ evento, ingresso, nomeDoSetor, fila, numero, precoCentavos }: Props) {
  return (
    <article className="bilhete carimbo overflow-hidden" style={{ ["--altura-do-furo" as string]: "62%" }} aria-label="Ingresso digital">
      <div className="flex items-center justify-between bg-vermelho px-4 py-2 text-white">
        <span className="titulo-cartaz text-xl">Ingresso</span>
        <span className="etiqueta-mono">lugar marcado</span>
      </div>
      <div className="px-4 pt-3 pb-4">
        <p className="titulo-cartaz text-[2rem]">{evento.artista}</p>
        <p className="mt-1 text-sm font-semibold">
          {evento.turne} · {evento.local}, {evento.cidade}
        </p>
        <p className="etiqueta-mono mt-0.5 text-tinta-suave">{dataDoShow(evento.aconteceEm)}</p>

        <dl className="mt-4 grid grid-cols-3 gap-2 border-y-2 border-tinta py-3 text-center">
          <div>
            <dt className="text-xs font-semibold text-tinta-suave">Setor</dt>
            <dd className="titulo-cartaz mt-1 text-lg leading-none">{nomeDoSetor.replace(/^Setor /, "")}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-tinta-suave">Fila</dt>
            <dd className="titulo-cartaz mt-1 text-3xl leading-none">{fila}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-tinta-suave">Assento</dt>
            <dd className="titulo-cartaz mt-1 text-3xl leading-none">{String(numero).padStart(2, "0")}</dd>
          </div>
        </dl>
      </div>
      <div className="picote flex items-center gap-4 px-4 py-4">
        <Codigo2D codigo={ingresso.codigo} />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-tinta-suave">Código</p>
          <p className="font-mono text-lg font-semibold tracking-wide">{ingresso.codigo}</p>
          <p className="mt-2 text-sm">
            Valor: <span className="font-semibold">{reais(precoCentavos)}</span>
          </p>
          <p className="text-xs text-tinta-suave">Nenhum pagamento foi processado.</p>
        </div>
      </div>
    </article>
  );
}
