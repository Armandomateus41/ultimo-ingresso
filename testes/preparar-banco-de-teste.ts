import { criarBanco, prepararBanco } from "../src/servidor/banco";

export const URL_DO_BANCO_DE_TESTE =
  process.env.DATABASE_URL_TESTE ?? "postgres://ingresso:ingresso@localhost:55433/ultimo_ingresso_teste";

/** Antes de todos os testes: banco de teste do zero, com as migrações e os dados iniciais. */
export default async function setup() {
  const banco = criarBanco(URL_DO_BANCO_DE_TESTE, 2);
  try {
    await banco.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await prepararBanco(banco);
  } finally {
    await banco.end();
  }
}
