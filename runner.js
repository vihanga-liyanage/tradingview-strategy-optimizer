const fs = require("fs");
const csv = require("csv-parser");
const { chromium } = require("playwright");

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
const CHART_URL = config.chartUrl;
const SELECTORS = config.selectors;
const CONDITIONS = config.conditions || {};
const PARAMS_FILE = "params.csv";
const AUTH_FILE = "auth.json";

const SAMPLE_SIZE = (() => {
  const idx = process.argv.indexOf("--sample");
  if (idx !== -1 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1]);
  return null;
})();

const RESUME_FILE = (() => {
  const idx = process.argv.indexOf("--resume");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
})();

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

let RESULTS_FILE = `results_${getTimestamp()}.csv`;

function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

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
    await sleep(3000);
  } else {
    debugLog("No Update report button");
  }
}

async function setChartToLast30Days(page) {
  const selectorsToTry = [
    SELECTORS.chartRangeButton,
    '[data-name="chart-range"]',
    'button[class*="range"]',
    '[class*="rangeButton"]',
    'div[class*="time-range"] button',
  ];
  let rangeButtonClicked = false;
  for (const sel of selectorsToTry) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        debugLog("Opening chart range menu with selector:", sel);
        await loc.click({ timeout: 5000 });
        rangeButtonClicked = true;
        break;
      }
    } catch (_) {
      continue;
    }
  }
  if (!rangeButtonClicked) {
    console.warn("[WARN] Could not find chart range button. Set the chart to 'Last 30 days' manually, then re-run.");
    return;
  }
  await sleep(500);

  try {
    debugLog("Selecting Last 30 days");
    await page.locator(SELECTORS.last30DaysOption).click({ timeout: 5000 });
    await sleep(3000);
  } catch (e) {
    console.warn("[WARN] Could not select Last 30 days:", e.message);
  }
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
    if (hasValue(p.start) && hasValue(p.end)) {
      const s = String(p.start).trim().toLowerCase();
      const e = String(p.end).trim().toLowerCase();
      if (s !== e) return ["false", "true"];
      return [s === "true" ? "true" : "false"];
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

function prepareRanges(paramRows) {
  const allRanges = paramRows.map((p) => ({
    parameter: p.parameter,
    label: p.label,
    type: p.type,
    defaultValue: p.defaultValue,
    values: getValuesForParam(p),
  })).filter(r => r.values.length > 0);

  const ordered = [];
  const remaining = [...allRanges];
  const placed = new Set();

  while (remaining.length > 0) {
    const prevLen = remaining.length;
    for (let i = remaining.length - 1; i >= 0; i--) {
      const cond = CONDITIONS[remaining[i].parameter];
      if (!cond || placed.has(cond.dependsOn)) {
        ordered.push(remaining[i]);
        placed.add(remaining[i].parameter);
        remaining.splice(i, 1);
      }
    }
    if (remaining.length === prevLen) {
      ordered.push(...remaining);
      break;
    }
  }

  return ordered;
}

function getDefaults(paramRows) {
  const defaults = {};
  for (const p of paramRows) defaults[p.parameter] = p.defaultValue;
  return defaults;
}

function rawConditionMet(param, vals) {
  const cond = CONDITIONS[param];
  if (!cond) return true;
  const depVal = vals[cond.dependsOn];
  return depVal !== undefined &&
    String(depVal).trim().toLowerCase() === String(cond.requiredValue).trim().toLowerCase();
}

function countFilteredCombos(ordered, defaults) {
  function count(idx, vals) {
    if (idx === ordered.length) return 1;
    const r = ordered[idx];
    if (!rawConditionMet(r.parameter, vals)) {
      vals[r.parameter] = defaults[r.parameter] ?? r.values[0];
      const n = count(idx + 1, vals);
      delete vals[r.parameter];
      return n;
    }
    let total = 0;
    for (const v of r.values) {
      vals[r.parameter] = v;
      total += count(idx + 1, vals);
    }
    delete vals[r.parameter];
    return total;
  }
  return count(0, {});
}

function* generateFilteredCombos(ordered, defaults) {
  function* recurse(idx, vals) {
    if (idx === ordered.length) {
      const combo = {};
      for (const r of ordered) {
        combo[r.parameter] = { label: r.label, type: r.type, value: vals[r.parameter] };
      }
      yield combo;
      return;
    }
    const r = ordered[idx];
    if (!rawConditionMet(r.parameter, vals)) {
      vals[r.parameter] = defaults[r.parameter] ?? r.values[0];
      yield* recurse(idx + 1, vals);
      delete vals[r.parameter];
      return;
    }
    for (const v of r.values) {
      vals[r.parameter] = v;
      yield* recurse(idx + 1, vals);
    }
    delete vals[r.parameter];
  }
  yield* recurse(0, {});
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

function isClosedError(err) {
  const msg = (err && err.message) ? String(err.message) : "";
  return /target page, context or browser has been closed/i.test(msg) || /Target closed/i.test(msg);
}

async function waitForVisible(page, selector, name, timeout = 10000) {
  debugLog(`Waiting for: ${name}`);
  await page.locator(selector).first().waitFor({ state: "visible", timeout });
  debugLog(`Visible: ${name}`);
}

async function openStrategyInputs(page) {
  debugLog("Opening strategy context menu");
  const strategySelectors = [
    SELECTORS.strategyButton,
    "#\\:rp\\:",
    "#\\:rn\\:",
    '[data-name="strategy-tab"]',
    '[class*="strategy"]',
    'div[class*="tab"]:has-text("Strategy")',
  ];
  let clicked = false;
  for (const sel of strategySelectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.waitFor({ state: "visible", timeout: 5000 });
        await loc.click();
        clicked = true;
        break;
      }
    } catch (_) {
      continue;
    }
  }
  if (!clicked) {
    await waitForVisible(page, SELECTORS.strategyButton, "strategy button", 8000);
    await page.click(SELECTORS.strategyButton);
  }
  await sleep(1000);

  const settingsSelectors = [
    SELECTORS.settingsMenuItem,
    "text=Settings…",
    "text=Settings",
    "[aria-label*='Settings']",
    "[data-qa-id*='settings']",
    "button:has-text('Settings')",
    "div[role='menuitem']:has-text('Settings')",
    "a:has-text('Settings')",
    "[class*='menu']:has-text('Settings')",
  ];

  debugLog("Clicking Settings menu item");
  let settingsClicked = false;
  for (const sel of settingsSelectors) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.waitFor({ state: "visible", timeout: 5000 });
        await loc.click();
        settingsClicked = true;
        debugLog("Clicked settings with selector:", sel);
        break;
      }
    } catch (_) {
      continue;
    }
  }
  if (!settingsClicked) {
    try {
      await page.getByText("Settings…", { exact: true }).click({ timeout: 15000 });
      settingsClicked = true;
    } catch (_) {}
  }
  if (!settingsClicked) {
    await waitForVisible(page, SELECTORS.settingsMenuItem, "Settings menu item", 15000);
    await page.locator(SELECTORS.settingsMenuItem).first().click();
  }
  await sleep(600);

  debugLog("Clicking Inputs tab");
  await waitForVisible(page, SELECTORS.inputsTab, "Inputs tab");
  await page.locator(SELECTORS.inputsTab).first().click();
  await sleep(800);
}

async function closeDropdown(page) {
  debugLog("Closing dropdown by clicking Inputs tab");
  await page.locator(SELECTORS.inputsTab).first().click();
  await sleep(300);
}

function getStandardValueCell(page, label) {
  const exact = page.locator(
    `div.cell-RLntasnw.first-RLntasnw >> div.inner-RLntasnw:text-is("${label}")`
  );
  const fuzzy = page.locator(
    `div.cell-RLntasnw.first-RLntasnw >> div.inner-RLntasnw:text("${label}")`
  );
  const labelCell = exact.or(fuzzy).first();

  return {
    labelCell,
    valueCell: labelCell.locator(
      "xpath=ancestor::div[contains(@class,'cell-RLntasnw')][1]/following-sibling::div[contains(@class,'cell-RLntasnw')][1]"
    )
  };
}

function getEmbeddedCheckboxRow(page, label) {
  const exact = page.locator(`label.checkbox-Lah5SRBd:has(.label-Lah5SRBd:text-is("${label}"))`);
  const fuzzy = page.locator(`label.checkbox-Lah5SRBd:has(.label-Lah5SRBd:text("${label}"))`);
  return exact.or(fuzzy).first();
}

async function scrollLabelIntoView(page, labelCell, label) {
  try {
    await labelCell.scrollIntoViewIfNeeded({ timeout: 6000 });
  } catch (e) {
    throw new Error(`Parameter "${label}" not found in strategy Inputs. Remove it from params.csv or check the exact label in TradingView.`);
  }
}

async function setInputByLabel(page, label, value) {
  debugLog(`Trying to set input: "${label}" = ${value}`);

  const { labelCell, valueCell } = getStandardValueCell(page, label);
  await scrollLabelIntoView(page, labelCell, label);
  await labelCell.waitFor({ state: "visible", timeout: 10000 });

  const input = valueCell.locator('input[data-qa-id="ui-lib-Input-input"]').first();
  const count = await input.count();

  if (count === 0) {
    throw new Error(`No numeric input found for label: ${label}`);
  }

  await input.click();
  await sleep(100);
  await input.press("Control+A");
  await sleep(50);
  await input.fill(String(value));
  await sleep(100);

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
      await sleep(150);
    }
    return;
  }

  const { labelCell, valueCell } = getStandardValueCell(page, label);
  await scrollLabelIntoView(page, labelCell, label);
  await labelCell.waitFor({ state: "visible", timeout: 10000 });

  const checkbox = valueCell.locator('[aria-checked], input[type="checkbox"], [role="checkbox"]').first();
  const checked = normalizeBool(await checkbox.getAttribute("aria-checked"));

  if (checked !== shouldCheck) {
    await valueCell.click();
    await sleep(150);
  }
}

async function setSelectByLabel(page, label, value) {
  debugLog(`Trying to set select: "${label}" = ${value}`);

  const { labelCell, valueCell } = getStandardValueCell(page, label);
  await scrollLabelIntoView(page, labelCell, label);
  await labelCell.waitFor({ state: "visible", timeout: 10000 });

  const trigger = valueCell.locator('[role="button"], [aria-haspopup="listbox"], button').first();

  if (await trigger.count() === 0) {
    throw new Error(`No select trigger found for label: ${label}`);
  }

  await trigger.click();
  await sleep(300);

  await page.getByText(String(value), { exact: true }).last().click();
  await sleep(300);

  try {
    await closeDropdown(page);
  } catch {}
}

async function applyCombo(page, combo) {
  debugLog("Applying parameter combination");
  await openStrategyInputs(page);

  for (const [paramName, param] of Object.entries(combo)) {
    const cond = CONDITIONS[paramName];
    if (cond) {
      const dep = combo[cond.dependsOn];
      const depVal = dep ? String(dep.value).trim().toLowerCase() : undefined;
      const reqVal = String(cond.requiredValue).trim().toLowerCase();
      if (depVal !== reqVal) {
        debugLog(`Skipping "${paramName}" — "${cond.dependsOn}" is "${depVal}", needs "${reqVal}"`);
        continue;
      }
    }

    debugLog(`Applying ${paramName}:`, param);

    if (param.type === "numeric") {
      await setInputByLabel(page, param.label, param.value);
    } else if (param.type === "checkbox") {
      await setCheckboxByLabel(page, param.label, param.value);
    } else if (param.type === "select") {
      await setSelectByLabel(page, param.label, param.value);
    }

    await sleep(150);
  }

  debugLog("Clicking OK button");
  await page.locator(SELECTORS.okButton).click();
  await sleep(1000);
  await updateReportIfNeeded(page);
  await sleep(1500);
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
  await sleep(800);

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

  const ordered = prepareRanges(paramRows);
  const defaults = getDefaults(paramRows);
  const totalCount = countFilteredCombos(ordered, defaults);
  console.log(`Total unique combinations: ${totalCount.toLocaleString()}`);

  let combos = null;
  let comboCount = totalCount;

  if (SAMPLE_SIZE && SAMPLE_SIZE < totalCount) {
    combos = [];
    let si = 0;
    for (const combo of generateFilteredCombos(ordered, defaults)) {
      if (si < SAMPLE_SIZE) {
        combos.push(combo);
      } else {
        const j = Math.floor(Math.random() * (si + 1));
        if (j < SAMPLE_SIZE) combos[j] = combo;
      }
      si++;
    }
    comboCount = combos.length;
    console.log(`Random sample mode: ${comboCount} combinations selected`);
  }

  let startIndex = 0;

  if (RESUME_FILE) {
    if (!fs.existsSync(RESUME_FILE)) {
      console.error(`Resume file not found: ${RESUME_FILE}`);
      process.exit(1);
    }
    RESULTS_FILE = RESUME_FILE;
    const existingLines = fs.readFileSync(RESUME_FILE, "utf8").trim().split("\n");
    startIndex = Math.max(0, existingLines.length - 2);
    console.log(`Resuming from run ${startIndex + 1} (${startIndex} already completed in ${RESUME_FILE})`);
  } else {
    ensureResultsHeader(paramRows, staticParams);
  }

  const remaining = comboCount - startIndex;
  if (remaining <= 0) {
    console.log("All combinations already completed. Nothing to do.");
    return;
  }

  const estSeconds = remaining * 8;
  console.log(`Runs remaining: ${remaining} | Estimated time: ~${formatDuration(estSeconds)}`);

  debugLog("Launching browser. Headless = false");
  const browser = await chromium.launch({ headless: false });

  const hasAuth = fs.existsSync(AUTH_FILE);
  if (hasAuth) {
    debugLog(`Creating browser context with auth file: ${AUTH_FILE}`);
  } else {
    console.log(`No ${AUTH_FILE} found. Running without saved session (you may need to log in in the browser).`);
    console.log(`To save a session for next time, run: node save-session.js`);
  }
  const context = await browser.newContext({
    ...(hasAuth && { storageState: AUTH_FILE }),
    acceptDownloads: true,
  });

  const page = await context.newPage();

  debugLog(`Navigating to chart: ${CHART_URL}`);
  await page.goto(CHART_URL, { waitUntil: "domcontentloaded" });
  await sleep(4000);
  await setChartToLast30Days(page);
  await sleep(3000);
  await updateReportIfNeeded(page);

  console.log(`\nStarting ${remaining} runs...\n`);

  const runStart = Date.now();
  let successCount = 0;
  let failCount = 0;

  const source = combos || generateFilteredCombos(ordered, defaults);
  let i = 0;

  for (const combo of source) {
    if (i < startIndex) { i++; continue; }

    const runId = i + 1;
    const runNum = i - startIndex + 1;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt === 1) {
          console.log(`Run ${runId}/${comboCount} (${runNum}/${remaining})`);
        } else {
          console.log(`Run ${runId}/${comboCount} (retry)`);
        }
        debugLog("Current combo:", combo);

        await applyCombo(page, combo);

        const metrics = await readPerformanceSummary(page);
        appendResult(combo, metrics, paramRows);

        successCount++;

        const elapsed = (Date.now() - runStart) / 1000;
        const rate = runNum / elapsed;
        const left = Math.max(0, (remaining - runNum) / rate);
        console.log(`  [OK] ${formatDuration(elapsed)} elapsed | ETA ${formatDuration(left)}`);

        await sleep(500);
        break;
      } catch (err) {
        if (isClosedError(err)) {
          console.error("\nBrowser or tab was closed. Results so far are in: " + RESULTS_FILE);
          console.error(`Resume later with: node runner.js --resume ${RESULTS_FILE}`);
          try { await browser.close(); } catch (_) {}
          process.exit(1);
        }

        if (attempt === 1) {
          console.warn(`  [RETRY] Attempt 1 failed: ${err.message}`);
          debugLog(err.stack);
          await sleep(2000);
          continue;
        }

        console.error(`  [FAIL] Run ${runId} failed after retry: ${err.message}`);
        debugLog(err.stack);
        failCount++;
        try {
          if (!page.isClosed()) await saveFailureArtifacts(page, runId);
        } catch (_) {}
      }
    }

    i++;
  }

  console.log(`\nFinished. ${successCount} succeeded, ${failCount} failed.`);
  console.log(`Results saved to: ${RESULTS_FILE}`);

  try { await browser.close(); } catch (_) {}
  debugLog("Runner finished");
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  console.error(err.stack);
  process.exit(1);
});
