const fs = require("fs");
const csv = require("csv-parser");
const { chromium } = require("playwright");

const { chartUrl: CHART_URL, selectors: SELECTORS } = JSON.parse(fs.readFileSync("config.json", "utf8"));
const PARAMS_FILE = "params.csv";
const AUTH_FILE = "auth.json";

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

const RESULTS_FILE = `results_${getTimestamp()}.csv`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function normalizeBool(value) {
  return String(value).trim().toLowerCase() === "true";
}

function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
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
          defaultValue: String(row.defaultValue || "").trim(),
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
    if (hasValue(p.defaultValue)) {
      return [p.defaultValue];
    }
    return [];
  }

  if (p.type === "checkbox") {
    if (hasValue(p.options)) {
      return p.options.split("|").map(v => v.trim()).filter(Boolean);
    }
    if (hasValue(p.defaultValue)) {
      return [p.defaultValue];
    }
    return ["false"];
  }

  if (p.type === "select") {
    if (hasValue(p.options)) {
      return p.options.split("|").map(v => v.trim()).filter(Boolean);
    }
    if (hasValue(p.defaultValue)) {
      return [p.defaultValue];
    }
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

async function readStaticParams(sweptParamNames) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream("params_template.csv")
      .pipe(csv())
      .on("data", (row) => {
        const name = String(row.parameter || "").trim();
        if (name && !sweptParamNames.has(name)) {
          rows.push({ parameter: name, defaultValue: String(row.defaultValue || "").trim() });
        }
      })
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

function ensureResultsHeader(paramRows, staticParams) {
  const staticSection = staticParams
    .map((p) => `${p.parameter}=${p.defaultValue}`)
    .join(",");

  const header = [
    ...paramRows.map((p) => p.parameter),
    "netProfit",
    "maxDrawdown",
    "totalTrades",
    "profitableTrades",
    "profitFactor",
  ].join(",");

  fs.writeFileSync(RESULTS_FILE, staticSection + "\n" + header + "\n");
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

  await trigger.click();
  await sleep(600);

  await page.getByText(String(value), { exact: true }).last().click();
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
    metrics.netProfit,
    metrics.maxDrawdown,
    metrics.totalTrades,
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
  const sweptNames = new Set(paramRows.map((p) => p.parameter));
  const staticParams = await readStaticParams(sweptNames);
  const combos = generateCombinations(paramRows);

  ensureResultsHeader(paramRows, staticParams);

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

  console.log(`Total combinations: ${combos.length}`);

  for (let i = 0; i < combos.length; i++) {
    const combo = combos[i];
    const runId = i + 1;

    try {
      console.log(`Run ${runId}/${combos.length}`);
      debugLog("Current combo:", combo);

      await applyCombo(page, combo);

      const metrics = await readPerformanceSummary(page);
      appendResult(combo, metrics, paramRows);

      console.log(`Saved run ${runId}`);
      await sleep(1000);
    } catch (err) {
      console.error(`Run ${runId} failed: ${err.message}`);
      debugLog(err.stack);
      await saveFailureArtifacts(page, runId);
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