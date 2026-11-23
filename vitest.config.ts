import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["testes/**/*.test.ts"],
    globalSetup: ["testes/preparar-banco-de-teste.ts"],
    // Os testes de integração dividem o mesmo banco: um arquivo por vez.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
