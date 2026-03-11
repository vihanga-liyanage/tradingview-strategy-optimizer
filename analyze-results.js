const fs = require('fs');
const lines = fs.readFileSync('results_2026-03-09_16-11-35.csv', 'utf8').split('\n');
const dataRows = lines.slice(2).filter(l => l.trim());

function parseNum(s) {
  if (!s) return NaN;
  s = String(s).replace(/["\u2212]/g, '').replace(/,/g, '').trim();
  return parseFloat(s) || NaN;
}
function parsePct(s) {
  if (!s) return NaN;
  return parseFloat(String(s).replace('%','')) || NaN;
}

const rows = [];
for (const line of dataRows) {
  let netProfit, maxDD, trades, winRate, pf;
  const quoted = line.match(/,"([^"]+)","([^"]+)",(\d+),([\d.]+)%?,([\d.]+)$/);
  const unquoted = line.match(/,(-?\d[\d,.]*),"([^"]+)",(\d+),([\d.]+)%?,([\d.]+)$/);
  if (quoted) {
    netProfit = parseNum(quoted[1]);
    maxDD = parseNum(quoted[2]);
    trades = parseInt(quoted[3], 10);
    winRate = parsePct(quoted[4]);
    pf = parseFloat(quoted[5]);
  } else if (unquoted) {
    netProfit = parseNum(unquoted[1]);
    maxDD = parseNum(unquoted[2]);
    trades = parseInt(unquoted[3], 10);
    winRate = parsePct(unquoted[4]);
    pf = parseFloat(unquoted[5]);
  } else continue;
  rows.push({ line, netProfit, maxDrawdown: maxDD, totalTrades: trades, winRate, profitFactor: pf });
}

const valid = rows.filter(r => !isNaN(r.maxDrawdown) && !isNaN(r.netProfit));
const byDD = [...valid].sort((a, b) => a.maxDrawdown - b.maxDrawdown);
const byPnL = [...valid].sort((a, b) => b.netProfit - a.netProfit);
const byWR = [...valid].sort((a, b) => b.winRate - a.winRate);
const byPF = [...valid].sort((a, b) => b.profitFactor - a.profitFactor);

console.log('=== LOWEST DRAWDOWN ===');
const r1 = byDD[0];
console.log('Max drawdown:', r1.maxDrawdown, '| Net profit:', r1.netProfit, '| Win rate:', r1.winRate + '%', '| Profit factor:', r1.profitFactor);
console.log('Params:', r1.line.substring(0, 100) + '...');

console.log('\n=== HIGHEST PnL ===');
const r2 = byPnL[0];
console.log('Net profit:', r2.netProfit, '| Max drawdown:', r2.maxDrawdown, '| Win rate:', r2.winRate + '%', '| Profit factor:', r2.profitFactor);
console.log('Params:', r2.line.substring(0, 100) + '...');

console.log('\n=== BEST WIN RATE ===');
const r3 = byWR[0];
console.log('Win rate:', r3.winRate + '%', '| Net profit:', r3.netProfit, '| Max drawdown:', r3.maxDrawdown, '| Profit factor:', r3.profitFactor);
console.log('Params:', r3.line.substring(0, 100) + '...');

console.log('\n=== BEST PROFIT FACTOR ===');
const r4 = byPF[0];
console.log('Profit factor:', r4.profitFactor, '| Net profit:', r4.netProfit, '| Max drawdown:', r4.maxDrawdown, '| Win rate:', r4.winRate + '%');
console.log('Params:', r4.line.substring(0, 100) + '...');
