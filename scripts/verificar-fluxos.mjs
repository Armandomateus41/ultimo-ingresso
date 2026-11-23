// Percorre os dois caminhos no navegador, no computador e no celular, e salva capturas.
// Uso: node scripts/verificar-fluxos.mjs [url] [pasta]
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://localhost:3077";
const pasta = process.argv[3] ?? "capturas";
const navegador = await chromium.launch();
const falhas = [];
const conferir = (condicao, mensagem) => {
  if (!condicao) falhas.push(mensagem);
  console.log(`${condicao ? "ok " : "FALHOU"} ${mensagem}`);
};

async function abrir(nome, viewport, celular) {
  const contexto = await navegador.newContext({ viewport, deviceScaleFactor: celular ? 2 : 1, isMobile: celular, hasTouch: celular });
  const pagina = await contexto.newPage();
  const erros = [];
  pagina.on("pageerror", (e) => erros.push(e.message));
  // O 409 da disputa é esperado: o navegador só avisa que a requisição foi recusada.
  pagina.on("console", (m) => m.type() === "error" && !m.text().includes("status of 409") && erros.push(m.text()));
  await pagina.goto(url, { waitUntil: "networkidle" });
  await pagina.waitForSelector("[data-assento]");
  return { contexto, pagina, erros, foto: (arquivo) => pagina.screenshot({ path: `${pasta}/${nome}-${arquivo}.png`, fullPage: false }) };
}

async function escolherAssentoLivre(pagina, setor, celular) {
  if (celular) await pagina.getByRole("button", { name: setor === "CEN" ? "Central" : setor, exact: true }).click();
  await pagina.waitForTimeout(500);
  const livre = pagina.locator(`[data-assento^="${setor}-"][data-estado="livre"]`).first();
  const id = await livre.getAttribute("data-assento");
  await livre.click();
  return id;
}

for (const [nome, viewport, celular] of [
  ["desktop", { width: 1440, height: 960 }, false],
  ["celular", { width: 390, height: 844 }, true],
]) {
  console.log(`\n== ${nome}`);
  const { contexto, pagina, erros, foto } = await abrir(nome, viewport, celular);
  await foto("1-inicio");
  const larguras = await pagina.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  conferir(larguras[0] <= larguras[1], `sem rolagem lateral (${larguras[0]} de ${larguras[1]} px)`);

  if (!celular) {
    // Teclado: o primeiro assento do mapa recebe o foco, as setas andam e Enter escolhe.
    await pagina.locator('[data-assento][tabindex="0"]').first().focus();
    await pagina.keyboard.press("ArrowRight");
    await pagina.keyboard.press("ArrowDown");
    const focado = await pagina.evaluate(() => document.activeElement?.getAttribute("data-assento"));
    await pagina.keyboard.press("Enter");
    const painel = await pagina.getByRole("region", { name: /Lugar escolhido|Lugar indisponível/ }).count();
    conferir(!!focado && painel === 1, `teclado: setas levaram a ${focado} e Enter abriu o painel`);
  }

  // Caminho 1: escolher, reservar com clique duplo, confirmar.
  const id = await escolherAssentoLivre(pagina, "CEN", celular);
  const reservar = pagina.getByRole("button", { name: /Reservar por \d+ segundos/ });
  await reservar.dblclick();
  await pagina.getByRole("timer").waitFor();
  await pagina.waitForTimeout(1200);
  await foto("2-reservado");
  conferir((await pagina.locator(`[data-assento="${id}"]`).getAttribute("aria-label")).includes("sua reserva"), `${id} aparece como sua reserva no mapa`);
  await pagina.getByRole("button", { name: "Confirmar compra" }).click();
  await pagina.getByLabel("Ingresso digital").waitFor();
  await pagina.getByLabel("Ingresso digital").scrollIntoViewIfNeeded();
  await foto("3-ingresso");
  conferir((await pagina.locator(`[data-assento="${id}"]`).getAttribute("aria-label")).includes("comprado por você"), `${id} aparece como comprado`);

  // Caminho 1b: deixar o tempo acabar.
  await pagina.getByRole("button", { name: "Escolher outro lugar" }).click();
  const outro = await escolherAssentoLivre(pagina, "CEN", celular);
  await pagina.getByRole("button", { name: /Reservar por \d+ segundos/ }).click();
  await pagina.getByRole("timer").waitFor();
  await pagina.getByRole("region", { name: "Tempo esgotado" }).waitFor({ timeout: 45_000 });
  await pagina.waitForTimeout(800);
  await foto("4-tempo-esgotado");
  conferir((await pagina.locator(`[data-assento="${outro}"]`).getAttribute("data-estado")) === "livre", `${outro} voltou a ficar livre no mapa`);

  // Caminho 2: disputa Ana × Bruno.
  await pagina.getByRole("button", { name: /Disputar o último lugar/ }).click();
  await pagina.getByRole("button", { name: "Disparar as duas compras" }).click();
  await pagina.getByText("Conseguiu", { exact: true }).waitFor();
  await pagina.waitForTimeout(900);
  await foto("5-disputa");
  const conseguiram = await pagina.getByText("Conseguiu", { exact: true }).count();
  const naoConseguiram = await pagina.getByText("Não conseguiu", { exact: true }).count();
  conferir(conseguiram === 1 && naoConseguiram === 1, `disputa: ${conseguiram} conseguiu, ${naoConseguiram} não conseguiu`);
  const estadoDoAlvo = await pagina.locator('[data-assento="CAM-A-07"]').getAttribute("aria-label");
  conferir(/reservado por (Ana|Bruno)/.test(estadoDoAlvo), `o último lugar ficou com um deles (${estadoDoAlvo})`);
  await pagina.getByRole("button", { name: /Reservar a alternativa para/ }).click();
  await pagina.getByText(/201 · reservado para/).waitFor();
  await pagina.waitForTimeout(600);
  await foto("6-alternativa");

  for (let i = 0; i < 3; i++) {
    await pagina.getByRole("button", { name: "Repetir a disputa" }).click();
    await pagina.getByRole("button", { name: "Repetir a disputa" }).waitFor();
    const um = (await pagina.getByText("Conseguiu", { exact: true }).count()) === 1;
    conferir(um, `repetição ${i + 1}: exatamente um conseguiu`);
  }
  conferir(erros.length === 0, `sem erros no console${erros.length ? `: ${erros[0].slice(0, 160)}` : ""}`);
  await contexto.close();
}

await navegador.close();
if (falhas.length) {
  console.log(`\n${falhas.length} falha(s)`);
  process.exit(1);
}
console.log("\nTudo certo.");
