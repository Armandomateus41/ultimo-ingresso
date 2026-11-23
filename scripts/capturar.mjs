// Capturas de conferência: node scripts/capturar.mjs [url] [pasta]
import { chromium } from "playwright";
const url = process.argv[2] ?? "http://localhost:3077";
const pasta = process.argv[3] ?? "capturas";
const navegador = await chromium.launch();
for (const [nome, viewport, mobile] of [["desktop", { width: 1440, height: 960 }, false], ["celular", { width: 390, height: 844 }, true]]) {
  const contexto = await navegador.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile });
  const pagina = await contexto.newPage();
  const erros = [];
  pagina.on("console", (m) => m.type() === "error" && erros.push(m.text()));
  pagina.on("pageerror", (e) => erros.push(e.message));
  await pagina.goto(url, { waitUntil: "networkidle" });
  await pagina.waitForSelector("[data-assento]");
  await pagina.screenshot({ path: `${pasta}/${nome}-inicio.png` });
  console.log(nome, "erros:", erros.length ? erros : "nenhum");
  await contexto.close();
}
await navegador.close();
