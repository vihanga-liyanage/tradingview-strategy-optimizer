const fs = require("fs");
const { chromium } = require("playwright");

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
const CHART_URL = config.chartUrl;
const SKIP_LABELS = config.skipLabels || [];
const SELECTORS = config.selectors || {};
const AUTH_FILE = "auth.json";
const OUTPUT_FILE = "params_template.csv";

const DEBUG = true;

function debugLog(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openStrategyInputs(page) {
  debugLog("Clicking strategy button");
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
    if (!sel) continue;
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click();
        clicked = true;
        debugLog("Clicked strategy with selector:", sel);
        break;
      }
    } catch (_) {
      continue;
    }
  }
  if (!clicked) {
    await page.click("#\\:rp\\:");
  }
  await sleep(1000);

  debugLog("Clicking Settings");
  const settingsSelectors = [
    SELECTORS.settingsMenuItem,
    "text=Settings…",
    "text=Settings",
    "div[role='menuitem']:has-text('Settings')",
    "button:has-text('Settings')",
  ];

  let settingsClicked = false;
  for (const sel of settingsSelectors) {
    if (!sel) continue;
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
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
    await page.getByText("Settings…", { exact: true }).click();
  }
  await sleep(1200);

  debugLog("Clicking Inputs");
  const inputsSelectors = [SELECTORS.inputsTab, "text=Inputs"];
  for (const sel of inputsSelectors) {
    if (!sel) continue;
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click();
        break;
      }
    } catch (_) {
      continue;
    }
  }
  await sleep(1500);
}

async function closeDropdown(page) {
  debugLog("Closing dropdown by clicking Inputs tab");
  const sel = SELECTORS.inputsTab || "text=Inputs";
  await page.locator(sel).first().click();
  await sleep(500);
}

async function extractParams(page) {
  debugLog("Extracting parameters");

  const results = [];
  const seenLabels = new Set();

  const labelNodes = page.locator("div.cell-RLntasnw.first-RLntasnw div.inner-RLntasnw");
  const labelCount = await labelNodes.count();

  const labels = [];
  for (let i = 0; i < labelCount; i++) {
    const txt = (await labelNodes.nth(i).innerText()).trim();
    if (txt) labels.push(txt);
  }

  debugLog(`Found standard label rows: ${labels.length}`);

  for (const label of labels) {
    try {
      if (SKIP_LABELS.includes(label)) {
        debugLog(`Skipping configured label: ${label}`);
        continue;
      }

      const labelCell = page.locator(
        `div.cell-RLntasnw.first-RLntasnw >> div.inner-RLntasnw:text-is("${label}")`
      ).first();

      await labelCell.waitFor({ state: "visible", timeout: 10000 });

      const valueCell = labelCell.locator(
        "xpath=ancestor::div[contains(@class,'cell-RLntasnw')][1]/following-sibling::div[contains(@class,'cell-RLntasnw')][1]"
      );

      const numericInput = valueCell.locator('input[data-qa-id="ui-lib-Input-input"]').first();
      const checkbox = valueCell.locator(
        '[aria-checked], input[type="checkbox"], [role="checkbox"]'
      ).first();
      const selectTrigger = valueCell.locator(
        '[role="button"], [aria-haspopup="listbox"], button'
      ).first();

      let value = "";
      let type = "unknown";
      let options = "";

      if (await numericInput.count() > 0) {
        value = await numericInput.inputValue();
        type = "numeric";
        debugLog(`Numeric extracted for "${label}": ${value}`);
      } else if (await checkbox.count() > 0) {
        const ariaChecked = await checkbox.getAttribute("aria-checked");
        let checked = ariaChecked;

        if (checked == null) {
          try {
            checked = (await checkbox.isChecked()).toString();
          } catch {
            checked = "false";
          }
        }

        value = checked === "true" ? "true" : "false";
        type = "checkbox";
        debugLog(`Checkbox extracted for "${label}": ${value}`);
      } else if (await selectTrigger.count() > 0) {
        value = (await selectTrigger.innerText()).trim();
        type = "select";
        debugLog(`Current select value for "${label}": ${value}`);

        try {
          await selectTrigger.click();
          await sleep(700);

          const optionLocators = page.locator('[role="option"]');
          const optionCount = await optionLocators.count();

          const vals = [];
          for (let j = 0; j < optionCount; j++) {
            const txt = (await optionLocators.nth(j).innerText()).trim();
            if (txt) vals.push(txt);
          }

          options = [...new Set(vals)].join("|");
          debugLog(`Options for "${label}": ${options}`);

          await closeDropdown(page);
        } catch (e) {
          debugLog(`Could not extract options for "${label}": ${e.message}`);
          await closeDropdown(page);
        }
      } else {
        debugLog(`Skipping unsupported row: ${label}`);
        continue;
      }

      const parameter = label
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .split(/\s+/)
        .map((word, idx) =>
          idx === 0
            ? word.charAt(0).toLowerCase() + word.slice(1)
            : word.charAt(0).toUpperCase() + word.slice(1)
        )
        .join("");

      results.push({
        parameter,
        label,
        type,
        defaultValue: value,
        options,
      });

      seenLabels.add(label);
      debugLog(`Captured: ${label} -> ${value} (${type})`);
    } catch (err) {
      debugLog(`Skipping row due to error: ${label} -> ${err.message}`);
      try {
        await closeDropdown(page);
      } catch {}
    }
  }

  const checkboxRows = page.locator('label.checkbox-Lah5SRBd');
  const checkboxCount = await checkboxRows.count();

  debugLog(`Found embedded checkbox rows: ${checkboxCount}`);

  for (let i = 0; i < checkboxCount; i++) {
    try {
      const row = checkboxRows.nth(i);
      const labelNode = row.locator('.label-Lah5SRBd').first();

      if (await labelNode.count() === 0) continue;

      const label = (await labelNode.innerText()).trim();
      if (!label) continue;
      if (SKIP_LABELS.includes(label)) {
        debugLog(`Skipping configured checkbox label: ${label}`);
        continue;
      }
      if (seenLabels.has(label)) {
        debugLog(`Skipping duplicate checkbox label: ${label}`);
        continue;
      }

      const input = row.locator('input[type="checkbox"]').first();
      if (await input.count() === 0) continue;

      const ariaChecked = await input.getAttribute("aria-checked");
      const value = ariaChecked === "true" ? "true" : "false";

      const parameter = label
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .split(/\s+/)
        .map((word, idx) =>
          idx === 0
            ? word.charAt(0).toLowerCase() + word.slice(1)
            : word.charAt(0).toUpperCase() + word.slice(1)
        )
        .join("");

      results.push({
        parameter,
        label,
        type: "checkbox",
        defaultValue: value,
        options: "",
      });

      seenLabels.add(label);
      debugLog(`Captured embedded checkbox: ${label} -> ${value}`);
    } catch (err) {
      debugLog(`Skipping embedded checkbox due to error: ${err.message}`);
    }
  }

  return results;
}

function writeCsv(rows) {
  const lines = ["parameter,label,type,defaultValue,options,start,end,step"];

  for (const row of rows) {
    lines.push(
      [
        csvEscape(row.parameter),
        csvEscape(row.label),
        csvEscape(row.type),
        csvEscape(row.defaultValue),
        csvEscape(row.options || ""),
        csvEscape(row.defaultValue),
        csvEscape(row.defaultValue),
        csvEscape("1")
      ].join(",")
    );
  }

  fs.writeFileSync(OUTPUT_FILE, lines.join("\n"));
  console.log(`Saved ${OUTPUT_FILE} (${rows.length} parameters)`);
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const hasAuth = fs.existsSync(AUTH_FILE);
  if (!hasAuth) {
    console.log(`No ${AUTH_FILE} found. You may need to log in in the browser. Run 'node save-session.js' to save a session for next time.`);
  }
  const context = await browser.newContext({
    ...(hasAuth && { storageState: AUTH_FILE }),
  });

  const page = await context.newPage();
  await page.goto(CHART_URL, { waitUntil: "domcontentloaded" });
  await sleep(5000);

  await openStrategyInputs(page);
  const params = await extractParams(page);
  writeCsv(params);

  await browser.close();
})();
