import { Pool } from "pg";
import { MIGRACOES, SEMENTE } from "./esquema";

export type Banco = Pool;

/** Cria um pool de conexões. O app usa um só (obterBanco); os testes criam o deles apontando para o banco de teste. */
export function criarBanco(url: string, maximoDeConexoes = 10): Banco {
  return new Pool({ connectionString: url, max: maximoDeConexoes });
}

const global = globalThis as unknown as { __bancoUltimoIngresso?: Banco };

/** Pool único do app. Fica no globalThis para o recarregamento do `next dev` não abrir pools novos a cada edição. */
export function obterBanco(): Banco {
  if (!global.__bancoUltimoIngresso) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Defina DATABASE_URL (veja o .env.example).");
    global.__bancoUltimoIngresso = criarBanco(url);
  }
  return global.__bancoUltimoIngresso;
}

/**
 * Aplica as migrações que faltam e os dados iniciais.
 * A trava consultiva impede que dois processos (por exemplo, duas réplicas subindo juntas) migrem ao mesmo tempo.
 */
export async function prepararBanco(banco: Banco): Promise<string[]> {
  const conexao = await banco.connect();
  const aplicadas: string[] = [];
  try {
    await conexao.query("SELECT pg_advisory_lock(7231001)");
    await conexao.query("CREATE TABLE IF NOT EXISTS migracoes (nome text PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now())");
    const { rows } = await conexao.query<{ nome: string }>("SELECT nome FROM migracoes");
    const feitas = new Set(rows.map((linha) => linha.nome));
    for (const migracao of MIGRACOES) {
      if (feitas.has(migracao.nome)) continue;
      await conexao.query("BEGIN");
      try {
        await conexao.query(migracao.sql);
        await conexao.query("INSERT INTO migracoes (nome) VALUES ($1)", [migracao.nome]);
        await conexao.query("COMMIT");
        aplicadas.push(migracao.nome);
      } catch (erro) {
        await conexao.query("ROLLBACK");
        throw erro;
      }
    }
    await conexao.query(SEMENTE);
  } finally {
    await conexao.query("SELECT pg_advisory_unlock(7231001)").catch(() => {});
    conexao.release();
  }
  return aplicadas;
}
