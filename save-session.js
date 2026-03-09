const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto("https://www.tradingview.com/chart/WNyI4Dwb/");

  console.log("Login to TradingView, then press ENTER here...");
  process.stdin.once("data", async () => {
    await context.storageState({ path: "auth.json" });
    await browser.close();
    process.exit();
  });
})();