"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AssentoNoMapa, Setor } from "@/servidor/reservas";
import { reais } from "@/lib/formatar";
import {
  caixaDe,
  PALCO,
  PISTA,
  posicaoDoAssento,
  QUADRO_INTEIRO,
  RAIO_DO_ASSENTO,
  ROTULOS_DOS_SETORES,
  type Caixa,
  type Ponto,
} from "@/lib/layout-do-mapa";

/*
 * Mapa interativo. Cada estado tem forma própria, além da cor:
 *   livre = círculo vazado · reservado = círculo hachurado · vendido = círculo cheio com X
 *   sua reserva = círculo mostarda com visto · Ana e Bruno = círculo com a inicial.
 * Teclado: Tab entra no mapa, setas andam entre assentos vizinhos, Enter ou espaço escolhe.
 */

export type Marcacao = "disputa" | "alternativa";

type Props = {
  assentos: AssentoNoMapa[];
  setores: Setor[];
  selecionado: string | null;
  minhaReservaId: string | null;
  marcacoes: Record<string, Marcacao>;
  foco: string | null;
  aoMudarFoco: (setor: string | null) => void;
  aoTocarAssento: (assento: AssentoNoMapa) => void;
};

type AssentoPosicionado = AssentoNoMapa & Ponto;

const NOMES_CURTOS: Record<string, string> = { MAR: "Maré", CEN: "Central", SOL: "Sol", CAM: "Camarote" };

export function descreverEstado(assento: AssentoNoMapa, minhaReservaId: string | null) {
  if (assento.reservaId && assento.reservaId === minhaReservaId) return assento.estado === "vendido" ? "comprado por você" : "sua reserva";
  if (assento.estado === "livre") return "livre";
  if (assento.estado === "vendido") return "vendido";
  if (assento.comprador === "Ana" || assento.comprador === "Bruno") return `reservado por ${assento.comprador}`;
  return "reservado por outra pessoa";
}

/** Anima a troca de viewBox (zoom num setor) sem biblioteca. */
function useCaixaAnimada(alvo: Caixa): Caixa {
  const [atual, setAtual] = useState(alvo);
  const atualRef = useRef(alvo);
  useEffect(() => {
    const inicio = atualRef.current;
    const duracao = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420;
    const t0 = performance.now();
    let quadro = 0;
    const passo = (agora: number) => {
      const t = duracao ? Math.min(1, (agora - t0) / duracao) : 1;
      const e = 1 - Math.pow(1 - t, 3);
      const caixa = {
        x: inicio.x + (alvo.x - inicio.x) * e,
        y: inicio.y + (alvo.y - inicio.y) * e,
        largura: inicio.largura + (alvo.largura - inicio.largura) * e,
        altura: inicio.altura + (alvo.altura - inicio.altura) * e,
      };
      atualRef.current = caixa;
      setAtual(caixa);
      if (t < 1) quadro = requestAnimationFrame(passo);
    };
    quadro = requestAnimationFrame(passo);
    return () => cancelAnimationFrame(quadro);
  }, [alvo]);
  return atual;
}

function useTelaEstreita() {
  const [estreita, setEstreita] = useState(false);
  useEffect(() => {
    const consulta = window.matchMedia("(max-width: 640px)");
    const atualizar = () => setEstreita(consulta.matches);
    atualizar();
    consulta.addEventListener("change", atualizar);
    return () => consulta.removeEventListener("change", atualizar);
  }, []);
  return estreita;
}

export function MapaDoShow({ assentos, setores, selecionado, minhaReservaId, marcacoes, foco, aoMudarFoco, aoTocarAssento }: Props) {
  const estreita = useTelaEstreita();
  const refs = useRef(new Map<string, SVGGElement>());

  const posicionados = useMemo<AssentoPosicionado[]>(
    () => assentos.map((a) => ({ ...a, ...posicaoDoAssento(a.setor, a.fila, a.numero) })),
    [assentos],
  );

  const caixasDosSetores = useMemo(() => {
    const caixas: Record<string, Caixa> = {};
    for (const setor of setores) {
      const pontos = posicionados.filter((a) => a.setor === setor.id);
      if (pontos.length) caixas[setor.id] = caixaDe(pontos, setor.id === "CAM" ? 46 : 34);
    }
    return caixas;
  }, [posicionados, setores]);

  const alvo = useMemo(() => {
    // No celular, o mapa inteiro ganha uma faixa livre em cima para o aviso "toque num setor".
    if (!foco || !caixasDosSetores[foco]) return estreita ? { ...QUADRO_INTEIRO, y: -70, altura: QUADRO_INTEIRO.altura + 70 } : QUADRO_INTEIRO;
    const c = caixasDosSetores[foco];
    // O camarote é uma fila só: no celular, abre mais o quadro para não ficar uma tira fininha.
    if (foco === "CAM" && estreita) return { x: c.x, y: c.y - 70, largura: c.largura, altura: c.altura + 140 };
    return c;
  }, [foco, caixasDosSetores, estreita]);
  const caixa = useCaixaAnimada(alvo);

  // No celular, com o mapa inteiro na tela, os assentos ficam pequenos demais para o dedo: o primeiro toque aproxima o setor.
  const precisaAproximar = estreita && !foco;

  const visiveis = foco ? posicionados.filter((a) => a.setor === foco) : posicionados;
  const tabulavel =
    (selecionado && visiveis.find((a) => a.id === selecionado)?.id) ??
    visiveis.find((a) => a.estado === "livre")?.id ??
    visiveis[0]?.id;

  function vizinho(origem: AssentoPosicionado, dx: number, dy: number) {
    let melhor: AssentoPosicionado | null = null;
    let melhorNota = Infinity;
    for (const a of visiveis) {
      if (a.id === origem.id) continue;
      const vx = a.x - origem.x;
      const vy = a.y - origem.y;
      const avanco = vx * dx + vy * dy;
      if (avanco <= 4) continue;
      const lateral = Math.abs(vx * dy - vy * dx);
      if (lateral > avanco * 1.2) continue;
      const nota = avanco + lateral * 2.5;
      if (nota < melhorNota) {
        melhorNota = nota;
        melhor = a;
      }
    }
    return melhor;
  }

  function aoTeclar(evento: KeyboardEvent<SVGGElement>, assento: AssentoPosicionado) {
    const direcoes: Record<string, [number, number]> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
    if (evento.key in direcoes) {
      evento.preventDefault();
      const [dx, dy] = direcoes[evento.key];
      const proximo = vizinho(assento, dx, dy);
      if (proximo) refs.current.get(proximo.id)?.focus();
    } else if (evento.key === "Enter" || evento.key === " ") {
      evento.preventDefault();
      aoTocarAssento(assento);
    }
  }

  const nomeDoSetor = (id: string) => setores.find((s) => s.id === id)?.nome ?? id;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 overflow-x-auto border-b-2 border-tinta px-3 py-2 whitespace-nowrap" role="group" aria-label="Aproximar um setor">
        <BotaoDeFoco ativo={!foco} aoClicar={() => aoMudarFoco(null)}>
          Mapa inteiro
        </BotaoDeFoco>
        {setores.map((s) => (
          <BotaoDeFoco key={s.id} ativo={foco === s.id} aoClicar={() => aoMudarFoco(s.id)}>
            {NOMES_CURTOS[s.id] ?? s.nome}
          </BotaoDeFoco>
        ))}
      </div>

      <div className="mapa relative min-h-0 flex-1">
        <svg
          viewBox={`${caixa.x} ${caixa.y} ${caixa.largura} ${caixa.altura}`}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label="Mapa da Arena Mangue: palco, pista e assentos numerados"
        >
          <defs>
            <pattern id="hachura" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" fill="#f3eada" />
              <line x1="0" y1="0" x2="0" y2="5" stroke="#1c1730" strokeWidth="2.2" />
            </pattern>
            <pattern id="pista" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
              <rect width="8" height="8" fill="#f2b33a" />
              <line x1="0" y1="0" x2="0" y2="8" stroke="#e39f1f" strokeWidth="3" />
            </pattern>
          </defs>

          {/* Palco */}
          <g aria-hidden="true">
            <rect x={PALCO.x} y={PALCO.y} width={PALCO.largura} height={PALCO.altura} rx="6" fill="#1c1730" />
            {Array.from({ length: 9 }, (_, i) => (
              <circle key={i} cx={PALCO.x + 30 + i * 35} cy={PALCO.y + 14} r="4" fill="#f2b33a" />
            ))}
            <text x={500} y={PALCO.y + 62} textAnchor="middle" className="titulo-cartaz" fontSize="34" fill="#f3eada" letterSpacing="6">
              Palco
            </text>
          </g>

          {/* Pista em pé */}
          <g aria-hidden="true">
            <polygon points={PISTA.map((p) => `${p.x},${p.y}`).join(" ")} fill="url(#pista)" stroke="#1c1730" strokeWidth="2.5" />
            <rect x={436} y={296} width={128} height={34} rx="4" fill="#1c1730" />
            <text x={500} y={318} textAnchor="middle" fontSize="13" fill="#f3eada" fontFamily="var(--font-mono)">
              mesa de som
            </text>
            <text x={500} y={232} textAnchor="middle" className="titulo-cartaz" fontSize="40" fill="#1c1730">
              Pista
            </text>
            <text x={500} y={258} textAnchor="middle" fontSize="15" fill="#1c1730" fontFamily="var(--font-mono)">
              em pé · esgotada
            </text>
          </g>

          {/* Nomes e preços dos setores */}
          {setores.map((s) => {
            const r = ROTULOS_DOS_SETORES[s.id];
            if (!r) return null;
            return (
              <g key={s.id} aria-hidden="true">
                <text x={r.x} y={r.y} textAnchor="middle" className="titulo-cartaz" fontSize="26" fill="#1c1730">
                  {s.nome}
                </text>
                <text x={r.x} y={r.y + 19} textAnchor="middle" fontSize="13.5" fill="#5e566f" fontFamily="var(--font-mono)">
                  {reais(s.precoCentavos)}
                </text>
              </g>
            );
          })}

          {/* Moldura do camarote */}
          <rect x={330} y={662} width={340} height={56} rx="6" fill="none" stroke="#1c1730" strokeWidth="2" strokeDasharray="6 5" aria-hidden="true" />

          {/* Áreas de toque dos setores, para aproximar no celular */}
          {precisaAproximar &&
            Object.entries(caixasDosSetores).map(([id, c]) => (
              <rect
                key={id}
                x={c.x}
                y={c.y}
                width={c.largura}
                height={c.altura}
                fill="transparent"
                onClick={() => aoMudarFoco(id)}
                aria-hidden="true"
                style={{ cursor: "zoom-in" }}
              />
            ))}

          {posicionados.map((assento) => (
            <Assento
              key={assento.id}
              assento={assento}
              nomeDoSetor={nomeDoSetor(assento.setor)}
              selecionado={assento.id === selecionado}
              minhaReservaId={minhaReservaId}
              marcacao={marcacoes[assento.id]}
              tabulavel={assento.id === tabulavel}
              apagado={!!foco && assento.setor !== foco}
              registrar={(el) => {
                if (el) refs.current.set(assento.id, el);
                else refs.current.delete(assento.id);
              }}
              aoTocar={() => (precisaAproximar ? aoMudarFoco(assento.setor) : aoTocarAssento(assento))}
              aoTeclar={(e) => aoTeclar(e, assento)}
            />
          ))}
        </svg>

        {precisaAproximar && (
          <p className="pointer-events-none absolute inset-x-0 top-2 mx-auto w-fit rounded-md bg-tinta px-3 py-1.5 text-sm font-semibold text-papel">
            Toque num setor para ver os assentos
          </p>
        )}
      </div>
    </div>
  );
}

function BotaoDeFoco({ ativo, aoClicar, children }: { ativo: boolean; aoClicar: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={aoClicar}
      aria-pressed={ativo}
      className={`min-h-9 shrink-0 rounded-md border-2 px-2.5 text-sm font-semibold transition-colors ${
        ativo ? "border-tinta bg-tinta text-papel" : "border-tinta/25 bg-transparent text-tinta hover:border-tinta"
      }`}
    >
      {children}
    </button>
  );
}

type PropsDoAssento = {
  assento: AssentoPosicionado;
  nomeDoSetor: string;
  selecionado: boolean;
  minhaReservaId: string | null;
  marcacao?: Marcacao;
  tabulavel: boolean;
  apagado: boolean;
  registrar: (el: SVGGElement | null) => void;
  aoTocar: () => void;
  aoTeclar: (evento: KeyboardEvent<SVGGElement>) => void;
};

function Assento({ assento, nomeDoSetor, selecionado, minhaReservaId, marcacao, tabulavel, apagado, registrar, aoTocar, aoTeclar }: PropsDoAssento) {
  const { x, y } = assento;
  const r = RAIO_DO_ASSENTO;
  const meu = !!assento.reservaId && assento.reservaId === minhaReservaId;
  const inicial = assento.estado === "reservado" && (assento.comprador === "Ana" || assento.comprador === "Bruno") ? assento.comprador[0] : null;
  const descricao = `${nomeDoSetor}, fila ${assento.fila}, assento ${assento.numero}: ${descreverEstado(assento, minhaReservaId)}`;

  let corpo: React.ReactNode;
  if (meu) {
    corpo = (
      <>
        <circle className="corpo" cx={x} cy={y} r={r} fill={assento.estado === "vendido" ? "#0e6b60" : "#f2b33a"} stroke="#1c1730" strokeWidth="2.2" />
        <path
          d={`M${x - 4.5} ${y + 0.5} l3 3.2 l6 -7`}
          fill="none"
          stroke={assento.estado === "vendido" ? "#fff" : "#1c1730"}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    );
  } else if (inicial) {
    corpo = (
      <>
        <circle className="corpo" cx={x} cy={y} r={r} fill={inicial === "A" ? "#c23a23" : "#0e6b60"} stroke="#1c1730" strokeWidth="2.2" />
        <text x={x} y={y + 4.6} textAnchor="middle" fontSize="13" fontWeight="800" fill="#fff" fontFamily="var(--font-sans)">
          {inicial}
        </text>
      </>
    );
  } else if (assento.estado === "vendido") {
    corpo = (
      <>
        <circle className="corpo" cx={x} cy={y} r={r} fill="#1c1730" />
        <path d={`M${x - 4} ${y - 4} L${x + 4} ${y + 4} M${x + 4} ${y - 4} L${x - 4} ${y + 4}`} stroke="#f3eada" strokeWidth="2" strokeLinecap="round" />
      </>
    );
  } else if (assento.estado === "reservado") {
    corpo = <circle className="corpo" cx={x} cy={y} r={r} fill="url(#hachura)" stroke="#1c1730" strokeWidth="2.2" />;
  } else {
    corpo = <circle className="corpo" cx={x} cy={y} r={r} fill="#fbf6ec" stroke="#1c1730" strokeWidth="2.2" />;
  }

  return (
    <g
      ref={registrar}
      className="assento"
      data-estado={assento.estado}
      data-assento={assento.id}
      role="button"
      tabIndex={tabulavel ? 0 : -1}
      aria-label={descricao}
      aria-pressed={selecionado}
      onClick={aoTocar}
      onKeyDown={aoTeclar}
      opacity={apagado ? 0.3 : 1}
    >
      <title>{descricao}</title>
      {/* área de toque maior que o desenho */}
      <circle cx={x} cy={y} r={r + 4} fill="transparent" />
      {marcacao && (
        <circle
          className={marcacao === "disputa" && assento.estado === "livre" ? "pulso" : undefined}
          cx={x}
          cy={y}
          r={r + 6}
          fill="none"
          stroke={marcacao === "disputa" ? "#c23a23" : "#0e6b60"}
          strokeWidth="2.5"
          strokeDasharray={marcacao === "alternativa" ? "4 3" : undefined}
        />
      )}
      {selecionado && <circle cx={x} cy={y} r={r + 5} fill="none" stroke="#c23a23" strokeWidth="3.5" />}
      {corpo}
      <circle className="anel-foco" cx={x} cy={y} r={r + 8} />
    </g>
  );
}

/** Desenhos da legenda, os mesmos do mapa. */
export function Legenda({ comDisputa }: { comDisputa: boolean }) {
  const itens: { rotulo: string; desenho: React.ReactNode }[] = [
    { rotulo: "Livre", desenho: <circle cx="12" cy="12" r="9" fill="#fbf6ec" stroke="#1c1730" strokeWidth="2" /> },
    { rotulo: "Reservado", desenho: <circle cx="12" cy="12" r="9" fill="url(#hachura-legenda)" stroke="#1c1730" strokeWidth="2" /> },
    {
      rotulo: "Vendido",
      desenho: (
        <>
          <circle cx="12" cy="12" r="9" fill="#1c1730" />
          <path d="M8.5 8.5 L15.5 15.5 M15.5 8.5 L8.5 15.5" stroke="#f3eada" strokeWidth="2" strokeLinecap="round" />
        </>
      ),
    },
    {
      rotulo: "Seu",
      desenho: (
        <>
          <circle cx="12" cy="12" r="9" fill="#f2b33a" stroke="#1c1730" strokeWidth="2" />
          <path d="M8 12.5 l3 3 l5.5 -6.5" fill="none" stroke="#1c1730" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ),
    },
  ];
  if (comDisputa) {
    itens.push(
      {
        rotulo: "Ana",
        desenho: (
          <>
            <circle cx="12" cy="12" r="9" fill="#c23a23" stroke="#1c1730" strokeWidth="2" />
            <text x="12" y="16.3" textAnchor="middle" fontSize="12" fontWeight="800" fill="#fff">
              A
            </text>
          </>
        ),
      },
      {
        rotulo: "Bruno",
        desenho: (
          <>
            <circle cx="12" cy="12" r="9" fill="#0e6b60" stroke="#1c1730" strokeWidth="2" />
            <text x="12" y="16.3" textAnchor="middle" fontSize="12" fontWeight="800" fill="#fff">
              B
            </text>
          </>
        ),
      },
    );
  }
  return (
    <>
      <svg width="0" height="0" aria-hidden="true" className="absolute">
        <defs>
          <pattern id="hachura-legenda" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="5" height="5" fill="#f3eada" />
            <line x1="0" y1="0" x2="0" y2="5" stroke="#1c1730" strokeWidth="2.2" />
          </pattern>
        </defs>
      </svg>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm font-medium" aria-label="Legenda do mapa">
        {itens.map((item) => (
          <li key={item.rotulo} className="flex items-center gap-1.5">
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
              {item.desenho}
            </svg>
            {item.rotulo}
          </li>
        ))}
      </ul>
    </>
  );
}
