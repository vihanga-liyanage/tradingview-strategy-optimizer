# TradingView Strategy Optimizer

Automates parameter sweeping for a TradingView strategy. It opens your chart in a browser, iterates through every combination of parameters you define, reads the backtest performance metrics from the page after each change, and saves all results to a timestamped CSV file.

---

## Setup & Running

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- A TradingView account with access to the target chart and strategy

### 1. Install dependencies

```bash
npm install
npx playwright install chromium
```

### 2. Save your TradingView session

The tool needs a saved browser session so it can access your chart without logging in each time.

```bash
node save-session.js
```

This opens a browser and navigates to TradingView. Log in to your account, then come back to the terminal and press **Enter**. The session is saved to `auth.json`.

### 3. Set your chart URL

Open `config.json` and set `chartUrl` to your chart:

```json
{
  "chartUrl": "https://www.tradingview.com/chart/YOUR_CHART_ID/",
  "selectors": { ... },
  "skipLabels": [ ... ]
}
```

All three scripts (`runner.js`, `extract-params.js`, `save-session.js`) read from this file — you only need to set `chartUrl` once. The other fields are explained below.

**Config fields:**

| Field | Used by | Description |
|---|---|---|
| `chartUrl` | all scripts | URL of your TradingView chart |
| `selectors` | `runner.js` | CSS/text selectors for TradingView UI elements. Update these if the page structure changes and automation breaks. |
| `skipLabels` | `extract-params.js` | Strategy input labels to ignore when extracting parameters (e.g. display-only fields like colors, positions, and dates). Add or remove labels here to control what ends up in `params_template.csv`. |

### 4. Populate `params_template.csv`

Run the extractor to automatically pull every parameter from your strategy's Inputs panel and write them to `params_template.csv`:

```bash
node extract-params.js
```

This opens a browser, navigates to your chart, reads all parameter names, current values, types, and available options, then writes them to `params_template.csv`. Run this whenever your strategy's inputs change.


### 5. Configure `params.csv`

Copy rows from `params_template.csv` into `params.csv` for each parameter you want to sweep. Set the `start`, `end`, and `step` columns for numeric ranges, or populate `options` for select/checkbox parameters.

See the [CSV Configuration](#csv-configuration) section below for the full format.

### 6. Run

```bash
node runner.js
```

A browser window will open and the tool will work through all parameter combinations automatically. Results are saved to a file named `results_YYYY-MM-DD_HH-MM-SS.csv` in the same directory.

---

## CSV Configuration

### `params_template.csv` — All strategy parameters

This file is the source of truth for every input your strategy accepts. It serves two purposes:

1. Provides default values for parameters that are **not** being swept (these are written to the top of the results file as context).
2. Acts as a reference/starting point when creating `params.csv`.

**Columns:**

| Column | Description |
|---|---|
| `parameter` | Internal parameter name (must match exactly what the strategy uses) |
| `label` | The label text shown in the TradingView Inputs panel |
| `type` | `numeric`, `checkbox`, or `select` |
| `defaultValue` | The default value for this parameter |
| `options` | Pipe-separated list of options (for `select` and `checkbox` sweeps) |
| `start` / `end` / `step` | Range definition for `numeric` sweeps |

### `params.csv` — Parameters to sweep

Same format as `params_template.csv`, but only contains the parameters you want to vary. The tool generates every combination of values across all listed parameters.

**Example:**

```
parameter,label,type,defaultValue,options,start,end,step
tickTPDistance,📏 Tick TP Distance,numeric,15,,30,60,5
stopLossMode,🛑 Stop Loss Mode,select,Trailing SL,Trailing SL|Fixed Tick SL,,,
enableDailyLimits,💵 Enable Daily Limits,checkbox,true,true|false,,,
```

**Value generation rules by type:**

- **`numeric`** — If `start`, `end`, and `step` are provided, generates a range of values from `start` to `end` inclusive. If only `defaultValue` is set, uses that single value.
- **`select`** — Tests each option listed in `options` (pipe-separated). Falls back to `defaultValue` if `options` is empty.
- **`checkbox`** — Tests each value listed in `options` (e.g. `true|false`). Falls back to `defaultValue`.

---

## Results File

Each run produces a file named `results_YYYY-MM-DD_HH-MM-SS.csv`.

**Structure:**

```
param1=value1,param2=value2,...        ← static parameters (line 1)
sweptParam1,sweptParam2,...,netProfit,maxDrawdown,totalTrades,profitableTrades,profitFactor
30,Trailing SL,...,1500.00,200.00,45,32,1.8
35,Trailing SL,...,1750.00,180.00,42,31,2.1
...
```

- **Line 1** — All parameters from `params_template.csv` that are *not* being swept, shown as `key=value` pairs. This gives you the fixed context for the entire run.
- **Line 2** — Column headers: the swept parameter names followed by the five metric columns.
- **Remaining lines** — One row per parameter combination, with the swept values used and the backtest metrics recorded.

**Metrics captured:**

| Column | TradingView metric |
|---|---|
| `netProfit` | Total P&L |
| `maxDrawdown` | Max equity drawdown |
| `totalTrades` | Total trades |
| `profitableTrades` | Profitable trades |
| `profitFactor` | Profit factor |

---

## How It Works

1. **Reads `params.csv`** and generates every combination of parameter values (cartesian product).
2. **Reads `params_template.csv`** to identify static parameters (those not being swept) and their defaults.
3. **Creates the results CSV** with static params on line 1 and the column header on line 2.
4. **Launches Chromium** (visible, not headless) using your saved `auth.json` session.
5. **Navigates to your chart** and sets the date range to "Last 30 days".
6. For each combination:
   - Opens the strategy Settings → Inputs panel.
   - Sets each parameter value using browser automation (supports numeric inputs, checkboxes, and dropdowns).
   - Clicks OK and waits for the backtest to update.
   - Reads the five metrics from the Performance Summary panel.
   - Appends a row to the results CSV.
7. If a run fails, a screenshot is saved as `debug-failed-run-N.png` and the loop continues with the next combination.

---

## Tips

- **Total combinations** = product of value counts across all swept parameters. Check the console output at startup before a large run.
- **Debug logging** is enabled by default (`DEBUG = true` in `runner.js`). Set it to `false` to reduce console noise.
- If TradingView prompts you to "Update report", the tool handles this automatically.
- The session in `auth.json` will eventually expire. Re-run `node save-session.js` to refresh it.
- Do not interact with the browser window while the tool is running.
