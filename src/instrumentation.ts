/**
 * Ao iniciar o servidor (dev, `next start`, Docker ou Vercel), aplica as migrações e os dados iniciais.
 * Com DATABASE_URL_MIGRACAO definida (conexão direta, sem pooler), as migrações usam essa conexão:
 * a trava consultiva que impede duas migrações ao mesmo tempo precisa de uma sessão de verdade.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const url = process.env.DATABASE_URL_MIGRACAO ?? process.env.DATABASE_URL;
  if (!url) {
    console.warn("[banco] DATABASE_URL não definida: as migrações não rodaram.");
    return;
  }
  const { criarBanco, prepararBanco } = await import("./servidor/banco");
  const banco = criarBanco(url, 1);
  try {
    const aplicadas = await prepararBanco(banco);
    if (aplicadas.length) console.log(`[banco] migrações aplicadas: ${aplicadas.join(", ")}`);
  } finally {
    await banco.end();
  }
}
