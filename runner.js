const fs = require("fs");
const readline = require("readline");
const csv = require("csv-parser");
const { chromium } = require("playwright");

const { chartUrl: CHART_URL, selectors: SELECTORS } = JSON.parse(fs.readFileSync("config.json", "utf8"));
const PARAMS_FILE = "params.csv";
const AUTH_FILE = "auth.json";
const RESUME_FILE = process.argv[2] || null;

const DEBUG = true;

function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");

  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate())
  ].join("-") + "_" +
  [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join("-");
}

const RESULTS_DIR = "results";
if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR);
const RESULTS_FILE = RESUME_FILE || `${RESULTS_DIR}/results_${getTimestamp()}.csv`;

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function comboKey(combo, variedParamRows) {
  return variedParamRows.map((p) => String(combo[p.parameter]?.value ?? "")).join("|");
}

function loadExistingResults(filePath, variedParamRows) {
  if (!filePath) return new Set();

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.trim().split("\n");

  // Find the data header row — it contains "totalTrades"
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("totalTrades")) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    console.warn(`Warning: could not find header row in ${filePath} — no runs will be skipped`);
    return new Set();
  }

  const headers = parseCsvLine(lines[headerIdx]);
  const paramIndices = variedParamRows.map((p) => headers.indexOf(p.parameter));

  if (paramIndices.some((idx) => idx === -1)) {
    console.warn("Warning: some parameters not found in resume file headers — no runs will be skipped");
    return new Set();
  }

  const done = new Set();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvLine(line);
    const key = paramIndices.map((idx) => cols[idx] ?? "").join("|");
    done.add(key);
  }

  return done;
}

function normalizeBool(value) {
  return String(value).trim().toLowerCase() === "true";
}

function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

async function reconnectIfNeeded(page) {
  const btn = page.locator(SELECTORS.reconnectButton);
  if (await btn.count() > 0 && await btn.first().isVisible().catch(() => false)) {
    console.log("Session disconnected — clicking Connect...");
    await btn.first().click();
    await btn.first().waitFor({ state: "hidden", timeout: 30000 });
    console.log("Reconnected.");
    await sleep(3000);
    return true;
  }
  return false;
}

async function updateReportIfNeeded(page) {
  debugLog("Checking for Update report button");

  const btn = page.locator(SELECTORS.updateReportButton);

  if (await btn.count() > 0 && await btn.first().isVisible().catch(() => false)) {
    debugLog("Update report button found, clicking");
    await btn.first().click();
    await sleep(6000);
  } else {
    debugLog("No Update report button");
  }
}

async function setChartToLast30Days(page) {
  debugLog("Opening chart range menu");
  await page.locator(SELECTORS.chartRangeButton).click();
  await sleep(800);

  debugLog("Selecting Last 30 days");
  await page.locator(SELECTORS.last30DaysOption).click();
  await sleep(5000);
}

async function readParamRanges() {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(PARAMS_FILE)
      .pipe(csv())
      .on("data", (row) => {
        rows.push({
          parameter: String(row.parameter || "").trim(),
          label: String(row.label || "").trim(),
          type: String(row.type || "").trim().toLowerCase(),
          options: String(row.options || "").trim(),
          start: String(row.start || "").trim(),
          end: String(row.end || "").trim(),
          step: String(row.step || "").trim(),
        });
      })
      .on("end", () => resolve(rows.filter(r => r.parameter && r.label && r.type)))
      .on("error", reject);
  });
}

function buildValues(start, end, step) {
  const values = [];
  for (let v = start; v <= end + 1e-9; v += step) {
    values.push(Number(v.toFixed(10)));
  }
  debugLog(`Built values from ${start} to ${end} step ${step}:`, values);
  return values;
}

function getValuesForParam(p) {
  if (p.type === "numeric") {
    if (hasValue(p.start) && hasValue(p.end) && hasValue(p.step)) {
      return buildValues(Number(p.start), Number(p.end), Number(p.step));
    }
    if (hasValue(p.start)) return [p.start];
    return [];
  }

  if (p.type === "checkbox") {
    if (hasValue(p.options)) {
      return p.options.split("|").map(v => v.trim()).filter(Boolean);
    }
    if (hasValue(p.start)) return [p.start];
    return ["false"];
  }

  if (p.type === "select") {
    if (hasValue(p.options)) {
      return p.options.split("|").map(v => v.trim()).filter(Boolean);
    }
    if (hasValue(p.start)) return [p.start];
    return [];
  }

  return [];
}

function generateCombinations(paramRows) {
  const ranges = paramRows.map((p) => ({
    parameter: p.parameter,
    label: p.label,
    type: p.type,
    values: getValuesForParam(p),
  })).filter(r => r.values.length > 0);

  let combos = [{}];

  for (const range of ranges) {
    const next = [];
    for (const combo of combos) {
      for (const value of range.values) {
        next.push({
          ...combo,
          [range.parameter]: {
            label: range.label,
            type: range.type,
            value,
          },
        });
      }
    }
    combos = next;
  }

  return combos;
}

async function readStaticParams(allParamNames) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream("params_template.csv")
      .pipe(csv())
      .on("data", (row) => {
        const name = String(row.parameter || "").trim();
        if (name && !allParamNames.has(name)) {
          rows.push({ parameter: name, value: String(row.start || "").trim() });
        }
      })
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

async function readChartInfo(page) {
  const asset = await page.locator(SELECTORS.assetName).first().innerText();
  const timeframe = await page.locator(SELECTORS.timeframe).first().innerText();
  return { asset: asset.trim(), timeframe: timeframe.trim() };
}

function ensureResultsHeader(paramRows, staticParams, chartInfo) {
  const MAX_COLS = 14;
  const pairs = staticParams.flatMap((p) => [csvEscape(p.parameter), csvEscape(p.value)]);
  const staticRows = [];
  for (let i = 0; i < pairs.length; i += MAX_COLS) {
    staticRows.push(pairs.slice(i, i + MAX_COLS).join(","));
  }
  const staticSection = staticRows.join("\n");

  const chartInfoRow = [csvEscape("asset"), csvEscape(chartInfo.asset), csvEscape("timeframe"), csvEscape(chartInfo.timeframe)].join(",");

  const header = [
    ...paramRows.map((p) => p.parameter),
    "totalTrades",
    "netProfit",
    "maxDrawdown",
    "profitableTrades",
    "profitFactor",
  ].join(",");

  fs.writeFileSync(RESULTS_FILE, chartInfoRow + "\n" + staticSection + "\n" + header + "\n");
  debugLog(`Created results file: ${RESULTS_FILE}`);
}

async function waitForVisible(page, selector, name, timeout = 10000) {
  debugLog(`Waiting for: ${name}`);
  await page.locator(selector).first().waitFor({ state: "visible", timeout });
  debugLog(`Visible: ${name}`);
}

async function openStrategyInputs(page) {
  debugLog("Opening strategy context menu");
  await waitForVisible(page, SELECTORS.strategyButton, "strategy button");
  await page.click(SELECTORS.strategyButton);
  await sleep(1000);

  debugLog("Clicking Settings menu item");
  await waitForVisible(page, SELECTORS.settingsMenuItem, "Settings menu item");
  await page.locator(SELECTORS.settingsMenuItem).first().click();
  await sleep(1200);

  debugLog("Clicking Inputs tab");
  await waitForVisible(page, SELECTORS.inputsTab, "Inputs tab");
  await page.locator(SELECTORS.inputsTab).first().click();
  await sleep(1200);
}

async function closeDropdown(page) {
  debugLog("Closing dropdown by clicking Inputs tab");
  await page.locator(SELECTORS.inputsTab).first().click();
  await sleep(500);
}

function getStandardValueCell(page, label) {
  const labelCell = page.locator(
    `div.cell-RLntasnw.first-RLntasnw >> div.inner-RLntasnw:text-is("${label}")`
  ).first();

  return {
    labelCell,
    valueCell: labelCell.locator(
      "xpath=ancestor::div[contains(@class,'cell-RLntasnw')][1]/following-sibling::div[contains(@class,'cell-RLntasnw')][1]"
    )
  };
}

function getEmbeddedCheckboxRow(page, label) {
  return page.locator(`label.checkbox-Lah5SRBd:has(.label-Lah5SRBd:text-is("${label}"))`).first();
}

async function setInputByLabel(page, label, value) {
  debugLog(`Trying to set input: "${label}" = ${value}`);

  const { labelCell, valueCell } = getStandardValueCell(page, label);
  await labelCell.waitFor({ state: "visible", timeout: 10000 });

  const input = valueCell.locator('input[data-qa-id="ui-lib-Input-input"]').first();
  const count = await input.count();

  if (count === 0) {
    throw new Error(`No numeric input found for label: ${label}`);
  }

  await input.click();
  await sleep(150);
  await input.press("Meta+A");
  await sleep(100);
  await input.fill(String(value));
  await sleep(200);

  const finalValue = await input.inputValue();
  debugLog(`Final input value for "${label}": ${finalValue}`);
}

async function setCheckboxByLabel(page, label, value) {
  debugLog(`Trying to set checkbox: "${label}" = ${value}`);

  const shouldCheck = normalizeBool(value);

  const embeddedRow = getEmbeddedCheckboxRow(page, label);
  if (await embeddedRow.count() > 0) {
    const embeddedInput = embeddedRow.locator('input[type="checkbox"]').first();
    const checked = normalizeBool(await embeddedInput.getAttribute("aria-checked"));

    if (checked !== shouldCheck) {
      await embeddedRow.click();
      await sleep(300);
    }
    return;
  }

  const { labelCell, valueCell } = getStandardValueCell(page, label);
  await labelCell.waitFor({ state: "visible", timeout: 10000 });

  const checkbox = valueCell.locator('[aria-checked], input[type="checkbox"], [role="checkbox"]').first();
  const checked = normalizeBool(await checkbox.getAttribute("aria-checked"));

  if (checked !== shouldCheck) {
    await valueCell.click();
    await sleep(300);
  }
}

async function setSelectByLabel(page, label, value) {
  debugLog(`Trying to set select: "${label}" = ${value}`);

  const { labelCell, valueCell } = getStandardValueCell(page, label);
  await labelCell.waitFor({ state: "visible", timeout: 10000 });

  const trigger = valueCell.locator('[role="button"], [aria-haspopup="listbox"], button').first();

  if (await trigger.count() === 0) {
    throw new Error(`No select trigger found for label: ${label}`);
  }

  const option = page.getByText(String(value), { exact: true }).last();

  for (let attempt = 1; attempt <= 3; attempt++) {
    await trigger.click();
    await sleep(800);
    if (await option.isVisible().catch(() => false)) break;
    debugLog(`Select dropdown did not open on attempt ${attempt}, retrying...`);
  }

  await option.waitFor({ state: "visible", timeout: 5000 });
  await option.click();
  await sleep(600);

  try {
    await closeDropdown(page);
  } catch {}
}

async function applyCombo(page, combo) {
  debugLog("Applying parameter combination");
  await openStrategyInputs(page);

  for (const [paramName, param] of Object.entries(combo)) {
    debugLog(`Applying ${paramName}:`, param);

    if (param.type === "numeric") {
      await setInputByLabel(page, param.label, param.value);
    } else if (param.type === "checkbox") {
      await setCheckboxByLabel(page, param.label, param.value);
    } else if (param.type === "select") {
      await setSelectByLabel(page, param.label, param.value);
    }

    await sleep(300);
  }

  debugLog("Clicking OK button");
  await page.locator(SELECTORS.okButton).click();
  await sleep(2000);
  await updateReportIfNeeded(page);
  await sleep(3000);
}

async function getMetricValue(page, title) {
  debugLog(`Reading metric: ${title}`);

  const card = page.locator(".containerCell-zres18Ue").filter({
    has: page.locator(`.title-nEWm7_ye:text-is("${title}")`)
  }).first();

  await card.waitFor({ state: "visible", timeout: 15000 });

  const value = await card.locator(".value-DiHajR6I").first().innerText();
  debugLog(`Metric ${title} = ${value}`);

  return value.trim();
}

async function readPerformanceSummary(page) {
  debugLog("Reading performance summary from page");

  await page.locator(".items-IJWxYDAe").first().waitFor({ state: "visible", timeout: 15000 });
  await sleep(1500);

  return {
    netProfit: (await getMetricValue(page, "Total P&L")).replace(/^\+/, ""),
    maxDrawdown: await getMetricValue(page, "Max equity drawdown"),
    totalTrades: await getMetricValue(page, "Total trades"),
    profitableTrades: await getMetricValue(page, "Profitable trades"),
    profitFactor: await getMetricValue(page, "Profit factor"),
  };
}

function appendResult(combo, metrics, paramRows) {
  const row = [
    ...paramRows.map((p) => combo[p.parameter]?.value ?? ""),
    metrics.totalTrades,
    metrics.netProfit,
    metrics.maxDrawdown,
    metrics.profitableTrades,
    metrics.profitFactor,
  ].map(csvEscape);

  fs.appendFileSync(RESULTS_FILE, row.join(",") + "\n");
  debugLog("Appended result row to results file");
}

async function saveFailureArtifacts(page, runId) {
  try {
    const shotPath = `debug-failed-run-${runId}.png`;
    await page.screenshot({ path: shotPath, fullPage: true });
    debugLog(`Saved failure screenshot: ${shotPath}`);
  } catch (e) {
    console.error("Could not save screenshot:", e.message);
  }
}

async function main() {
  debugLog("Starting runner");

  const paramRows = await readParamRanges();
  const allParamNames = new Set(paramRows.map((p) => p.parameter));
  const variedParamRows = paramRows.filter((p) => getValuesForParam(p).length > 1);
  const fixedParamRows = paramRows.filter((p) => getValuesForParam(p).length === 1);
  const templateStaticParams = await readStaticParams(allParamNames);
  const fixedFromParams = fixedParamRows.map((p) => ({ parameter: p.parameter, value: String(getValuesForParam(p)[0]) }));
  const staticParams = [...fixedFromParams, ...templateStaticParams];
  const combos = generateCombinations(paramRows);
  const existingResults = loadExistingResults(RESUME_FILE, variedParamRows);
  const pendingCount = combos.filter((c) => !existingResults.has(comboKey(c, variedParamRows))).length;

  console.log(`Total combinations: ${combos.length}`);
  if (RESUME_FILE) console.log(`Already completed: ${existingResults.size} — runs remaining: ${pendingCount}`);
  if (pendingCount === 0) {
    console.log("Nothing to run.");
    process.exit(0);
  }
  const answer = await confirm("Proceed? [y/N] ");
  if (answer !== "y") {
    console.log("Aborted.");
    process.exit(0);
  }

  debugLog("Launching browser. Headless = false");
  const browser = await chromium.launch({ headless: false });

  debugLog(`Creating browser context with auth file: ${AUTH_FILE}`);
  const context = await browser.newContext({
    storageState: AUTH_FILE,
    acceptDownloads: true,
  });

  const page = await context.newPage();

  debugLog(`Navigating to chart: ${CHART_URL}`);
  await page.goto(CHART_URL, { waitUntil: "domcontentloaded" });
  await sleep(5000);
  await setChartToLast30Days(page);
  await sleep(5000);
  await updateReportIfNeeded(page);

  const chartInfo = await readChartInfo(page);
  debugLog(`Chart info: asset=${chartInfo.asset}, timeframe=${chartInfo.timeframe}`);
  if (!RESUME_FILE) ensureResultsHeader(variedParamRows, staticParams, chartInfo);

  for (let i = 0; i < combos.length; i++) {
    const combo = combos[i];
    const runId = i + 1;

    if (existingResults.has(comboKey(combo, variedParamRows))) {
      debugLog(`Skipping run ${runId} — already in results`);
      continue;
    }

    try {
      console.log(`Run ${runId}/${combos.length}`);
      debugLog("Current combo:", combo);

      await reconnectIfNeeded(page);
      await applyCombo(page, combo);

      const metrics = await readPerformanceSummary(page);
      appendResult(combo, metrics, variedParamRows);

      console.log(`Saved run ${runId}`);
      await sleep(1000);
    } catch (err) {
      console.error(`Run ${runId} failed: ${err.message}`);
      debugLog(err.stack);
      await saveFailureArtifacts(page, runId);

      const reconnected = await reconnectIfNeeded(page);
      if (reconnected) {
        console.log(`Retrying run ${runId} after reconnect...`);
        i--;  // re-run this combo on next iteration
      }
    }
  }

  debugLog("Closing browser");
  await browser.close();
  debugLog("Runner finished");
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  console.error(err.stack);
  process.exit(1);
});