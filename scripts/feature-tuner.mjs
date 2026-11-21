// feature-tuner.mjs — the self-improvement motor.
// Joins entriesLog (which tilt rules fired at entry) -> real-fills closes
// (net $ outcome) and nudges the tunable scoring knobs inside HARD CLAMPS
// when measured lift justifies it. Evidence-gated: n>=MIN_N per flag
// cohort, 4h cooldown per knob. It only touches ordering weights —
// sizing, stops, and brakes are never auto-tuned.
// Runs on the rapid heavy cadence (~10min). A nudge written to
// state/feature-tunables.json adopts on the exec's NEXT cycle — the
// improvement clock is cycle time, not deploy time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const S = (p) => path.join(ROOT, 'state', p);
const A = (p) => path.join(ROOT, 'api', p);
const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const round = (v, d = 4) => { const m = 10 ** d; return Math.round((+v || 0) * m) / m; };

const MIN_N = 15;               // evidence floor per flag cohort
const STEP = 5;                 // score points per nudge
const KNOB_COOLDOWN = 4 * 3600e3;
// hard clamps — the tuner can never push a knob outside these
const CLAMPS = {
  bubStrongDip: [0, 40], bubLeaderDeep: [0, 20], bubKnife: [-50, -10],
  bubDeadCat: [-30, 0], bubTurning: [0, 20],
};
// positive weights promote; negative weights veto — opposite nudge logic
const SIGN = { bubStrongDip: 1, bubLeaderDeep: 1, bubKnife: -1, bubDeadCat: -1, bubTurning: 1 };
const FLAG_OF = { bubStrongDip: 'strongDip', bubLeaderDeep: 'leaderDeep', bubKnife: 'knife', bubDeadCat: 'deadCat', bubTurning: 'turning' };

const main = () => {
  const ledger = load(A('live-ledger.json'), {});
  const entries = (ledger.entriesLog || []).filter((e) => typeof e === 'object' && e.ts);
  const fills = load(S('real-fills.json'), { fills: [] }).fills || [];
  const closes = fills.filter((f) => f && f.symbol && f.profit != null);

  // join: each close takes the latest same-symbol entry at/before it (48h horizon)
  const eps = [];
  for (const f of closes) {
    const cts = +(f.cTime ?? f.uTime ?? f.ts ?? 0);
    if (!cts) continue;
    let best = null;
    for (const e of entries)
      if (e.symbol === f.symbol && e.ts <= cts && cts - e.ts < 48 * 3600e3 && (!best || e.ts > best.ts)) best = e;
    if (best) eps.push({ net: round((+f.profit || 0) - (+f.fee || 0)), e: best });
  }

  const stat = (arr) => arr.length
    ? { n: arr.length, net: round(arr.reduce((s, x) => s + x.net, 0), 3), avg: round(arr.reduce((s, x) => s + x.net, 0) / arr.length, 4) }
    : { n: 0, net: 0, avg: 0 };

  const verdicts = load(S('feature-verdicts.json'), { since: Date.now(), lastNudge: {}, log: [] });
  const tunables = load(S('feature-tunables.json'), { v: {} });
  tunables.v ||= {};
  // seed unset knobs to the exec's env defaults — the file owns them from
  // here on; without this the knobs stay undefined and nothing can tune.
  const SEED = { bubStrongDip: 15, bubLeaderDeep: 5, bubKnife: -25, bubDeadCat: -10, bubTurning: 8 };
  for (const [k, d] of Object.entries(SEED)) if (tunables.v[k] == null) tunables.v[k] = d;

  // cohorts — per-flag AND the aggregate tilt tri-state
  const coh = (flag) => eps.filter((x) => ((x.e.bubFlags) || []).includes(flag));
  const buckets = {};
  for (const k of Object.keys(FLAG_OF)) buckets[FLAG_OF[k]] = stat(coh(FLAG_OF[k]));
  buckets.bubPromoted = stat(eps.filter((x) => (+x.e.bubTilt || 0) > 0));
  buckets.bubNeutral = stat(eps.filter((x) => x.e.bubTilt != null && +x.e.bubTilt === 0));
  buckets.bubPenalized = stat(eps.filter((x) => (+x.e.bubTilt || 0) < 0));
  buckets.weakTiltPos = stat(eps.filter((x) => (+x.e.weakTilt || 0) > 0));
  buckets.breadthWeakTape = stat(eps.filter((x) => Number.isFinite(+x.e.breadthDay) && +x.e.breadthDay < 0.4));
  buckets.all = stat(eps);

  const notes = [];
  for (const [knob, flag] of Object.entries(FLAG_OF)) {
    const st = buckets[flag];
    const [lo, hi] = CLAMPS[knob];
    const cur = tunables.v[knob];
    if (st.n < MIN_N) continue;
    if (Date.now() - (verdicts.lastNudge[knob] || 0) < KNOB_COOLDOWN) continue;
    // evidence direction: positive-weight knob grows when its cohort wins;
    // negative-weight knob deepens when its cohort bleeds.
    const dir = st.avg > 0 ? SIGN[knob] : -SIGN[knob];
    const next = Math.max(lo, Math.min(hi, cur + dir * STEP));
    if (next === cur) continue;
    tunables.v[knob] = next;
    verdicts.lastNudge[knob] = Date.now();
    const note = `🔧 tuner: ${knob} ${cur}→${next} (flag '${flag}' cohort n=${st.n} avg ${st.avg > 0 ? '+' : ''}${st.avg})`;
    notes.push(note);
    verdicts.log.push({ ts: Date.now(), knob, from: cur, to: next, n: st.n, avg: st.avg });
  }
  verdicts.log = (verdicts.log || []).slice(-500);

  const report = {
    at: new Date().toISOString(), episodes: eps.length, buckets,
    tunables: { ...tunables.v },
    notes,
  };
  verdicts.last = report;
  fs.writeFileSync(S('feature-verdicts.json'), JSON.stringify(verdicts, null, 1));
  fs.writeFileSync(S('feature-tunables.json'), JSON.stringify({ at: Date.now(), v: tunables.v }));
  for (const n of notes) console.log(n);
  console.log(`[feature-tuner] episodes=${eps.length} buckets=${Object.keys(buckets).length} nudges=${notes.length}`);
};

main();
