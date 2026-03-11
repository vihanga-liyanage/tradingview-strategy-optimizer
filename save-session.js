const fs = require("fs");
const readline = require("readline");
const { chromium } = require("playwright");

const { chartUrl: CHART_URL } = JSON.parse(fs.readFileSync("config.json", "utf8"));

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(CHART_URL);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Login to TradingView, then press ENTER here... ", async () => {
    rl.close();
    await context.storageState({ path: "auth.json" });
    await browser.close();
    console.log("Session saved to auth.json");
    process.exit(0);
  });
})();