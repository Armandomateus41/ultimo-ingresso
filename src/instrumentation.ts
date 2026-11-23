/** Ao iniciar o servidor (dev, `next start` ou Docker), aplica as migrações e os dados iniciais. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  if (!process.env.DATABASE_URL) {
    console.warn("[banco] DATABASE_URL não definida: as migrações não rodaram.");
    return;
  }
  const { obterBanco, prepararBanco } = await import("./servidor/banco");
  const aplicadas = await prepararBanco(obterBanco());
  if (aplicadas.length) console.log(`[banco] migrações aplicadas: ${aplicadas.join(", ")}`);
}
