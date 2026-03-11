# TradingView Strategy Optimizer — Setup Guide

This guide summarizes your current setup and what to do next.

---

## ✅ What’s already done

| Item | Status |
|------|--------|
| **Dependencies** | `npm install` — done |
| **Playwright Chromium** | Installed |
| **config.json** | Chart URL set to `https://www.tradingview.com/chart/J5nrZcp8/` |
| **auth.json** | Session/cookies present (TradingView login may still be valid) |
| **params_template.csv** | Filled with your strategy’s 40 parameters |
| **params.csv** | Configured to sweep: Tick TP Distance, Stop Loss Mode, Fixed SL Distance, Enable Daily Limits |

---

## ⚠️ Node.js and your terminal

Node.js is installed at `C:\Program Files\nodejs\`, but it may not be in your **PATH** in some terminals.

- If `node -v` or `npm install` work in your terminal, you’re fine.
- If you see “node is not recognized”, either:
  1. **Use a terminal that already has Node in PATH** (e.g. “Node.js command prompt”), or  
  2. **Add Node to PATH** (recommended):  
     - Windows: Settings → System → About → Advanced system settings → Environment Variables.  
     - Under “System variables” or “User variables”, edit **Path** and add:  
       `C:\Program Files\nodejs`  
     - Restart the terminal (and Cursor if needed).

For a **one-time fix** in the current PowerShell session you can run:

```powershell
$env:Path = "C:\Program Files\nodejs;" + $env:Path
```

---

## 🔧 Optional: refresh your TradingView session

Sessions in `auth.json` expire. If the optimizer can’t open your chart or asks you to log in again:

1. Open a terminal in the project folder.
2. Run:
   ```bash
   node save-session.js
   ```
3. Log in to TradingView in the browser that opens, then press **Enter** in the terminal.  
   Your session is saved to `auth.json`.

---

## 📍 1. Confirm chart URL

In **config.json**, `chartUrl` should point to **your** chart (with the strategy already added):

- Current value: `https://www.tradingview.com/chart/J5nrZcp8/`
- To change: open your chart in TradingView, copy the URL from the address bar, and paste it into `config.json` as `chartUrl`.

---

## 📊 2. Parameters you’re sweeping (params.csv)

Your **params.csv** is set to sweep:

- **tickTPDistance** (numeric): single value 30 (step 5).
- **stopLossMode** (select): `Trailing SL` and `Fixed Tick SL`.
- **fixedSLDistanceTicks** (numeric): 100 → 200, step 20 (6 values).
- **enableDailyLimits** (checkbox): `true` and `false`.

Total combinations: 1 × 2 × 6 × 2 = **24 runs**.

To sweep more values (e.g. more tick TP distances), edit **params.csv**: set `start`, `end`, and `step` for numeric params, or add more options in the `options` column for select/checkbox. Use **params_template.csv** as reference.

---

## ▶️ 3. Run the optimizer

In a terminal where `node` works (see “Node.js and your terminal” above):

```bash
cd c:\Users\Administrator\Desktop\tradingview-strategy-optimizer-main
node runner.js
```

- A Chromium window will open and go to your chart.
- Do not use the browser while it’s running.
- Results are written to `results_YYYY-MM-DD_HH-MM-SS.csv` in the same folder.

---

## 📁 Result file

Each run creates a CSV with:

- **Line 1:** Fixed parameters (from params_template, not in params.csv).
- **Line 2:** Headers (swept params + netProfit, maxDrawdown, totalTrades, profitableTrades, profitFactor).
- **Rest:** One row per combination with metrics.

You can open the CSV in Excel or any spreadsheet app to analyze and sort by profit factor, drawdown, etc.

---

## 🔄 If you change your strategy inputs

After you add/remove/rename inputs in your TradingView strategy:

1. Run:
   ```bash
   node extract-params.js
   ```
2. This updates **params_template.csv**.
3. Then update **params.csv** with the parameters (and ranges/options) you want to sweep.

---

## Quick reference

| Goal | Command |
|------|--------|
| Refresh login session | `node save-session.js` |
| Update param list from chart | `node extract-params.js` |
| Run optimization | `node runner.js` |

If something fails (e.g. “Update report” or wrong metrics), check **README.md** for selectors and debug tips. Debug logging is on by default in `runner.js` (`DEBUG = true`).
