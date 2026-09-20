/* Development tool: contact sheet of one accessory from several bearings.
   node turntable.mjs cap|bow                                              */
import puppeteer from "puppeteer";

const which = process.argv[2] === "bow" ? "bow" : "cap";
const browser = await puppeteer.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 940, height: 940 });
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
page.on("pageerror", (e) => problems.push(e.message));

await page.goto(`http://127.0.0.1:8000/preview.html?a=${which}`, { waitUntil: "domcontentloaded" });
try {
  await page.waitForFunction("window.__ready === true", { timeout: 40000 });
} catch {
  console.log("preview never became ready:\n" + [...new Set(problems)].join("\n"));
  await browser.close();
  process.exit(1);
}

const views = [["front", 0, 8], ["three", 40, 14], ["side", 90, 6], ["top", 25, 55], ["back", 180, 12]];
for (const [tag, yaw, pitch] of views) {
  await page.evaluate((y, p) => window.__view(y, p), yaw, pitch);
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: `tt_${which}_${tag}.png`, clip: { x: 0, y: 0, width: 900, height: 900 } });
}
console.log(problems.length ? "PROBLEMS:\n" + [...new Set(problems)].join("\n") : "clean");
await browser.close();
