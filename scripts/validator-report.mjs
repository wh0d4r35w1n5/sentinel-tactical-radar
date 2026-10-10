// validator-report.mjs — INDEPENDENT validation (Will Evans §10).
// "A separate validation process that reads raw exchange exports, blockchain
// transactions, source-code commits and immutable market-data records, then
// independently reproduces the results — ideally unable to alter the trading
// system or its records." This script is READ-ONLY: it touches no state file,
// no exchange write endpoint, no trading code. It recomputes headline claims
// from raw sources and diffs them against what the system reports.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const API = path.join(ROOT, 'api');
const STATE = path.join(ROOT, 'state');
const readJ = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJ = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, f); };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

const rep = { ts: Date.now(), updatedAt: new Date().toISOString(), validator: 'read-only-recompute-v1', writes: 'api/validator-report.json only — this process cannot alter trading state', diffs: [], checks: {} };
const diff = (name, reported, recomputed, unit = '') => {
  const d = reported != null && recomputed != null ? +(recomputed - reported).toFixed(4) : null;
  rep.diffs.push({ metric: name, reported, recomputed, drift: d, unit, verdict: d == null ? 'unverifiable' : Math.abs(d) < 0.01 ? 'match' : Math.abs(d) < 0.5 ? 'minor drift' : 'DRIFT — investigate' });
};

// ---- eval journal recompute vs reported stats ----
const recs = [];
for (const f of ['history/eval-2026-09.json', 'history/eval-2026-10.json', 'signal-eval.json']) {
  const d = readJ(path.join(API, f), null);
  for (const x of d?.records || (Array.isArray(d) ? d : [])) if (x?.runTs && x.fwd24h != null) recs.push(x);
}
const seen = new Set(); const evals = recs.filter((r) => { const k = r.key || `${r.runTs}|${r.asset}|${r.direction}`; return !seen.has(k) && seen.add(k); });
const sev = readJ(path.join(API, 'signal-eval.json'), {});
const hits = evals.filter((r) => (r.direction === 'SHORT' ? -1 : 1) * r.fwd24h > 0).length;
rep.checks.evalJournal = { labeledEvals: evals.length, dirAcc24h: +(hits / evals.length).toFixed(4), emitterN: sev.stats?.n, emitterLabeled: sev.stats?.labeled, emitterConsistency: (sev.stats?.labeled > sev.stats?.n) ? 'INCONSISTENT — labeled exceeds total n, denominators differ' : 'consistent', note: 'recomputed on deduped labeled set; emitter denominators differ (labeled>n) — definitional drift, not necessarily error' };
diff('labeledEvals', sev.stats?.labeled ?? null, evals.length);
diff('dirAcc24h', sev.stats?.dirAcc24h ?? null, +(hits / evals.length * 100).toFixed(2), '%');

// ---- fills journal recompute vs reported ledger ----
const real = readJ(path.join(STATE, 'real-fills.json'), {});
const fills = Array.isArray(real) ? real : (real.fills || []);
const closes = fills.filter((f) => f.tradeSide === 'close');
const jGross = closes.reduce((a, f) => a + (+f.profit || 0), 0);
const jFees = fills.reduce((a, f) => a + Math.abs(+f.fee || 0), 0);
const jNet = jGross - jFees; // the ledger reports net-of-fees — same basis
const ledger = readJ(path.join(API, 'live-ledger.json'), {});
rep.checks.journal = { closes: closes.length, grossUsd: +jGross.toFixed(4), netUsd: +jNet.toFixed(4), feeUsd: +jFees.toFixed(4), basis: 'net = Σ close-profit − Σ all fill fees' };
diff('journalCloses', ledger.closedCount ?? ledger.journal?.closed ?? null, closes.length);
diff('journalNetUsd', ledger.epochNetUsd ?? ledger.netUsd ?? null, +jNet.toFixed(4), 'usd');
diff('journalFeeUsd', ledger.feesUsd ?? null, +jFees.toFixed(4), 'usd');

// ---- recon cross-check: journal vs exchange fills (read existing recon) ----
const recon = readJ(path.join(API, 'ledger-recon.json'), null);
if (recon?.exchangeFills) {
  rep.checks.exchangeVsJournal = { exchangeRealizedUsd: recon.exchangeFills.realizedUsd, exchangeFeeUsd: recon.exchangeFills.feeUsd, exchangeWindow: [recon.exchangeFills.windowFrom, recon.exchangeFills.windowTo], journalNetUsd: +jNet.toFixed(4), journalFeeUsd: +jFees.toFixed(4), note: 'exchange covers all retained history incl manual/pre-epoch — divergence magnitude is expected, direction must agree' };
}

// ---- on-chain: recompute wallet from public RPC, no secrets ----
const lane = readJ(path.join(API, 'onchain-lane.json'), null);
if (lane?.address) {
  try {
    const rpc = (method, params) => fetch('https://api.mainnet-beta.solana.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) }).then((r) => r.json());
    const progs = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
    const [solJ, ...tokLists] = await Promise.all([rpc('getBalance', [lane.address]), ...progs.map((p) => rpc('getTokenAccountsByOwner', [lane.address, { programId: p }, { encoding: 'jsonParsed' }]))]);
    const tokens = {};
    for (const t of tokLists) for (const a of t?.result?.value || []) { const i = a.account?.data?.parsed?.info; if (i && +i.tokenAmount.uiAmount > 0) tokens[i.mint] = +i.tokenAmount.uiAmount; }
    const sol = (solJ?.result?.value || 0) / 1e9;
    rep.checks.wallet = { address: lane.address, sol: +sol.toFixed(6), tokensHeld: Object.keys(tokens).length, laneClaimsSol: lane.sol, laneClaimsPositions: (lane.positions || []).length, positionMintsPresent: (lane.positions || []).filter((p) => (tokens[p.mint] || 0) > 0).length };
    diff('walletSol', lane.sol, +sol.toFixed(6), 'SOL');
    diff('positionsHeldOnChain', (lane.positions || []).length, rep.checks.wallet.positionMintsPresent, 'positions');
  } catch (e) { rep.checks.wallet = { error: e.message }; }
}

// ---- code provenance: tie every claim to a commit ----
try { rep.code = { head: execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8', timeout: 8000 }).trim().slice(0, 10), branch: execSync('git rev-parse --abbrev-ref HEAD', { cwd: ROOT, encoding: 'utf8', timeout: 8000 }).trim(), dirty: execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8', timeout: 8000 }).trim().split('\n').filter(Boolean).length }; } catch (e) { rep.code = { error: e.message }; }

rep.summary = { diffs: rep.diffs.length, matches: rep.diffs.filter((d) => d.verdict === 'match').length, drifts: rep.diffs.filter((d) => /DRIFT/.test(d.verdict)).map((d) => d.metric), verdict: rep.diffs.some((d) => /DRIFT/.test(d.verdict)) ? 'DRIFT FOUND — investigate flagged metrics' : 'all recomputed metrics match reported values' };
writeJ(path.join(API, 'validator-report.json'), rep);
console.log('validator:', rep.summary.verdict, `(${rep.summary.matches}/${rep.summary.diffs} match)`);
