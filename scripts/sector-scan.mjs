// sector-scan.mjs — fast market-wide sector breadth scanner (30s).
// One public tickers call -> sector breadth/volume/leaders + 30min rotation deltas.
// Writes /opt/sentinel/state/sector-scan.json + /opt/sentinel/api/sector-scan.json.
import fs from 'node:fs';
import { smcContext } from './pattern-tag.mjs';

const ROOT = '/opt/sentinel';
const OUT_STATE = `${ROOT}/state/sector-scan.json`;
const OUT_API = `${ROOT}/api/sector-scan.json`;
const INTERVAL_MS = +(process.env.SECTOR_SCAN_MS || 30000);
const HIST_MAX = 2880;

const EXACT = {
  'INVERSE-ETF': 'SOXS SQQQ SSPC UVXY SDS SPXU TZA FAZ LABD YANG TECS WEBS DRV EDZ SDOW SRTY SKF QID PSQ MYY MZZ REW TWM TBT PST DXD EEV EPV FXP DUG SRS SDP EUM EUO GLL ZSL DZZ SVXY',
  'LONG-ETF': 'SOXL TQQQ SPCH SPXL TECL FAS LABU CURE YINN UDOW UMDD TNA QLD SSO ROM DDM MVV SAA UYM UYG UGE UPW FBG',
  'DEFENSE': 'LMT NOC RTX GD BA LHX HII TXT LDO ITA DFEN PLTR RHM SAAB KOG AVAV KTOS LDOS ESLT CW TDG HEI WWD HON MRCY RTXSTOCK AXON MOG ATRO HXL SPR TGI',
  'ENERGY': 'XOM CVX CL WTI BRENT OXY SLB COP EOG XLE USO NATGAS UNG BOIL KOLD DVN FANG MRO HES PSX VLO MPC OKE WMB KMI TRGP LNG SU CNQ CVE IMO ENB TRP BP SHEL TTE EQNR CVXSTOCK',
  'MINERS-METALS': 'XAU XAG XPD XPT GDX GDXJ NEM GOLD KGC AU AEM FNV WPM RGLD PAAS AG HL CDE SLV GLD PHYS PSLV COPX CPER URA URNM UUUU DNN LEU CCJ NXE UEC XAUT SILVER GOLDSTOCK',
  'SEMIS': 'NVDA AMD TSM AVGO INTC QCOM MU TXN ADI MRVL AMAT LRCX KLAC SNPS CDNS SKDD SOX SMH ARM ASML STM NXPI MPWR MCHP ON SWKS QRVO TER ENTG MKSI LSCC ALGM WOLF CRUS SLAB DIOD ACLS UCTT COHU ICHR RMBS MTSI CRDO ALAB SMCI DELL HPE WDC STX NTAP PSTG ANET CIEN LITE COHR VIAV FN AAOI SNDK',
  'MEGATECH': 'AAPL MSFT GOOG GOOGL AMZN META NFLX TSLA CRM ORCL ADBE NOW SHOP UBER ABNB COIN MSTR HOOD INTU PANW CRWD ZS OKTA FTNT NET DDOG MDB SNOW TEAM WDAY HUBS SQ PYPL V MA AXP DFS COF SOFI UPST AFRM NU TOST FOUR FIS FI APP PATH AI SOUN BBAI SERV QS ENPH SEDG FSLR RUN BABA JD PDD BIDU NTES TCEHY BILI NIO XPEV LI TCOM TRIP WMT COST TGT HD LOW NKE SBUX MCD YUM DIS NFLX PARA WBD ROKU PINS SNAP MTCH BMBL ZM DOCU BOX DBX SPOT WMG FOX FOXA NWS NWSA',
};
const LOOKUP = {};
for (const [sec, names] of Object.entries(EXACT)) for (const n of names.split(' ')) LOOKUP[n] = sec;

const classify = (sym) => {
  let base = sym.replace(/USDT$/, '');
  if (LOOKUP[base]) return LOOKUP[base];
  base = base.replace(/STOCK$/, '');
  if (LOOKUP[base]) return LOOKUP[base];
  if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|AVAX|LINK|DOT|MATIC|UNI|ATOM|NEAR|APT|SUI|SEI|TIA|ARB|OP|INJ|FIL|LTC|BCH|TRX|ETC|HBAR|VET|ALGO|FTM|TON|BNB)/.test(base)) return 'CRYPTO-MAJOR';
  return 'CRYPTO-ALT';
};

const state = { hist: [] };

async function scan() {
  const t0 = Date.now();
  const r = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES', { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  const sectors = {};
  for (const c of j?.data || []) {
    const sym = c.symbol || '';
    if (!sym.endsWith('USDT')) continue;
    const sec = classify(sym);
    const ch = (parseFloat(c.change24h) || 0) * 100;
    const vol = (parseFloat(c.quoteVolume || c.usdtVolume) || 0) / 1e6;
    const s = (sectors[sec] ||= { n: 0, up: 0, dn: 0, vol: 0, chSum: 0, lead: [] });
    s.n++; s.vol += vol; s.chSum += ch;
    if (ch > 0.5) s.up++; else if (ch < -0.5) s.dn++;
    s.lead.push({ s: sym, ch: +ch.toFixed(1), v: +vol.toFixed(1) });
  }
  for (const s of Object.values(sectors)) {
    s.meanCh = +(s.chSum / s.n).toFixed(2);
    s.vol = +s.vol.toFixed(0);
    s.breadth = +(s.up / s.n).toFixed(2);
    s.lead = s.lead.sort((a, b) => b.v - a.v).slice(0, 3);
    delete s.chSum;
  }
  const snap = { ts: Date.now(), ms: Date.now() - t0, sectors };
  const ref = state.hist.find(h => Date.now() - h.ts > 30 * 60e3) || state.hist[0];
  if (ref) {
    snap.rotation = {};
    for (const [sec, s] of Object.entries(sectors)) {
      const r0 = ref.sectors[sec];
      if (r0) snap.rotation[sec] = +(s.breadth - r0.breadth).toFixed(2);
    }
  }
  state.hist.push(snap);
  if (state.hist.length > HIST_MAX) state.hist.shift();
  // SMC context per open seat — published for statusd/board
try {
  const kl = JSON.parse(fs.readFileSync(`${ROOT}/state/klines-15m.json`, 'utf8'));
  const wl = JSON.parse(fs.readFileSync(`${ROOT}/api/wealth-live.json`, 'utf8'));
  const openSyms = new Set(((wl.futures && wl.futures.positions) || []).map(p => String(p.k || p.symbol || '').split(':')[0].replace('USDT', '')));
  const smc = {};
  for (const s of openSyms) {
    const e = kl[s + 'USDT'];
    const k = e && Array.isArray(e.rows) ? e.rows : (Array.isArray(e) ? e : null);
    if (!k || k.length < 30) continue;
    const ohlc = k.map(x => Array.isArray(x) ? { h: +x[2], l: +x[3], c: +x[4], v: +x[5] } : { h: +x.h, l: +x.l, c: +x.c, v: +x.qv });
    smc[s] = smcContext(ohlc);
  }
  snap.smc = smc;
  fs.writeFileSync(`${ROOT}/state/smc-live.json.tmp`, JSON.stringify({ smc, ts: Date.now() }));
  fs.renameSync(`${ROOT}/state/smc-live.json.tmp`, `${ROOT}/state/smc-live.json`);
} catch (e) { console.log('smc-snap', e.message); }
fs.writeFileSync(`${OUT_STATE}.tmp`, JSON.stringify(snap));
  fs.renameSync(`${OUT_STATE}.tmp`, OUT_STATE);
  fs.writeFileSync(`${OUT_API}.tmp`, JSON.stringify(snap));
  fs.renameSync(`${OUT_API}.tmp`, OUT_API);
  const hot = Object.entries(sectors).sort((a, b) => b[1].breadth - a[1].breadth).slice(0, 3)
    .map(([k, s]) => `${k} ${(s.breadth * 100) | 0}%`).join(' · ');
  console.log(`[${new Date().toISOString()}] scan ${snap.ms}ms | ${hot}`);
}

(async () => { for (;;) { try { await scan(); } catch (e) { console.log('scan fail:', String(e.message || e).slice(0, 120)); } await new Promise(r => setTimeout(r, INTERVAL_MS)); } })();
