const fs = require("fs");
const { chromium } = require("playwright");

const { chartUrl: CHART_URL } = JSON.parse(fs.readFileSync("config.json", "utf8"));

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(CHART_URL);

  console.log("Login to TradingView, then press ENTER here...");
  process.stdin.once("data", async () => {
    await context.storageState({ path: "auth.json" });
    await browser.close();
    process.exit();
  });
})();