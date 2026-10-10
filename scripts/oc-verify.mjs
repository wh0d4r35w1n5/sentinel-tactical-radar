// headless dashboard verification — screenshots at 3 widths + DOM assertions
import { execFileSync } from 'node:child_process';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'https://54.66.217.111/';
for (const w of [390, 768, 1440]) {
  try {
    execFileSync(CHROME, ['--headless', '--disable-gpu', '--hide-scrollbars',
      `--window-size=${w},1400`, '--virtual-time-budget=22000',
      `--screenshot=C:/Users/beaue/AppData/Local/Temp/oc-${w}.png`,
      '--ignore-certificate-errors', URL], { timeout: 90000, stdio: 'pipe' });
    console.log(w, 'shot ok');
  } catch (e) { console.log(w, 'fail', String(e.message).slice(0, 120)); }
}
// DOM state dump — what actually rendered
try {
  const dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--virtual-time-budget=22000',
    '--dump-dom', '--ignore-certificate-errors', URL], { timeout: 90000, maxBuffer: 20e6 }).toString();
  const ocIdx = dom.indexOf('ocPanel');
  console.log('ocPanel idx:', ocIdx);
  const rows = [...dom.matchAll(/data-oc="([^"]+)"/g)].map((m) => m[1].slice(0, 12));
  console.log('data-oc rows:', rows);
  const qty = [...dom.matchAll(/(\d[\d,.]*[KMB]?) · [\d.]+h · <a/g)].slice(0, 5).map((m) => m[0]);
  console.log('qty cells:', qty);
  const pnl = [...dom.matchAll(/\(\+?-?[\d.]+%\)/g)].slice(0, 6).map((m) => m[0]);
  console.log('pnl cells:', pnl);
  console.log('CONNECTING still present:', dom.includes('CONNECTING'));
} catch (e) { console.log('dom fail', String(e.message).slice(0, 120)); }
