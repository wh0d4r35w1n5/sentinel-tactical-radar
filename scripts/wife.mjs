#!/usr/bin/env node
// wife.mjs — The Wife (operator order: "constantly complains if she
// sees the balance falling"). Watches the combined ownable balance in
// api/wealth-live.json (futures.equityOwnUsd + solana.totalUsd) every
// ~20s, tracks the high-water mark, and escalates complaints to the
// Telegram outbox on drawdown:
//   mood 1 noticed      dd ≥ 0.4% or $0.25  — escalating cadence, ~12min+
//   mood 2 complaining  dd ≥ 1.2% or $0.60  — ~6min+
//   mood 3 furious      dd ≥ 2.5% or $1.25  — ~4min+
// Recovery to within 0.2% of HWM → one forgiveness line, reset.
// She writes state/wife.json — Arb/Fee Genius read her mood and lower
// their alert thresholds when she's angry ("they work with The Wife").
//
// v2 (operator complaint: "old data — noisy alerts non stop — incredibly
// repetitive and not cool or funny or witty, just annoying"):
//  * HWM expires — a peak older than 36h is ancient history; she
//    re-baselines from the last 24h of equity samples instead of raging
//    forever about money that left weeks ago.
//  * Dead-feed guard — wealth-live older than 5min means she's reading a
//    corpse; she doesn't nag off a corpse.
//  * Escalating cadence — nag interval grows each complaint (×1..4) and a
//    daily cap keeps her from becoming the noise she complains about.
//  * Shuffle-bag quips — every line is heard once before any repeats.
// v3 (operator order): Australian, AUD-first. Reads state/fx-aud.json
//    (maintained by wealth-watch; frankfurter rate, fallback ~1.43).

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const STATE = path.join(__dirname, '..', 'state');
const API_DIR = path.join(__dirname, '..', 'api');
const OUTBOX = path.join(STATE, 'tg-outbox.jsonl');
const MS = +(process.env.WIFE_MS || 20000);
const HWM_MAX_AGE_MS = +(process.env.WIFE_HWM_AGE_MS || 36 * 3600e3);
const FEED_STALE_MS = +(process.env.WIFE_FEED_STALE_MS || 5 * 60e3);
const DAY_NAG_CAP = +(process.env.WIFE_DAY_NAG_CAP || 12);
const FX_FALLBACK = +(process.env.WIFE_FX_FALLBACK || 1.4324);
const HWM_CAP = +(process.env.WIFE_HWM_CAP_USD || 0);

const rj = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8')); } catch { return fb; } };
const rjApi = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(API_DIR, f), 'utf8')); } catch { return fb; } };
const outbox = (text) => { try { fs.appendFileSync(OUTBOX, JSON.stringify({ ts: Date.now(), text, to: 'ops' }) + '\n'); } catch { } };
const audRate = () => +(rj('fx-aud.json', {})?.rate || 0) || FX_FALLBACK;
const fmtA = (usd) => 'A$' + (usd * audRate()).toFixed(2);

const save = () => { try { fs.writeFileSync(path.join(STATE, 'wife.json'), JSON.stringify(st)); } catch { } };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const firstBoot = !fs.existsSync(path.join(STATE, 'wife.json'));
let st = rj('wife.json', null) || { hwm: 0, hwmAt: 0, last: 0, mood: 0, moodSince: Date.now(), nagCount: 0, lastNagAt: 0 };

// recent-peak: max equity sample over `windowMs` (+ current) — the honest
// "high water" she can legitimately complain about losing ground from.
function recentPeak(windowMs = 24 * 3600e3) {
  try {
    const eb = rjApi('equity-bridge.json', null);
    const since = Date.now() - windowMs;
    const smp = (s) => Array.isArray(s) ? { t: +s[0], e: +s[1] } : { t: +s.t || +s.at || +s.ts || 0, e: +s.equityUsd || +s.equity || 0 };
    const p = Math.max(0, ...(eb?.equitySamples || []).map(smp).filter((x) => x.t >= since).map((x) => x.e),
      +(eb?.equityNowUsd || 0), +st.last || 0);
    return HWM_CAP > 0 ? Math.min(p, HWM_CAP) : p;
  } catch { return 0; }
}

// seed on first boot; afterwards, a HWM older than HWM_MAX_AGE_MS is a
// ghost — re-baseline so fury is about TODAY's fall, not ancient peaks.
if (firstBoot) {
  const p = recentPeak();
  if (p > st.hwm) { st.hwm = p; st.hwmAt = Date.now(); }
} else if ((!st.hwmAt || Date.now() - st.hwmAt > HWM_MAX_AGE_MS) && st.hwm > st.last * 1.01) {
  const p = recentPeak();
  st.hwm = Math.max(p, st.last); st.hwmAt = Date.now();
  log(`hwm expired (>36h old) — re-baselined to $${st.hwm.toFixed(2)}`);
}

// The pool: dry Australian — arithmetic, accusations, servo-pie
// economics, domestic menace. Caps for the moments that earn them.
// %D A$-lost · %P pct · %C current A$ · %H peak A$.
const QUIPS = {
  1: [
    'The Wife: %D down off the peak, mate. Was %H, now %C. Every trick counts in this stable — I keep receipts.',
    'The Wife: %C. Was %H this arvo. The stable don’t run on "nearly."',
    'The Wife: −%D. Small skims still rob the corner. Watch it.',
    'The Wife: Checked the bag before me emails. %C — was %H. Noted in my ledger — the one with teeth.',
    'The Wife: Not a whinge, a report: the stable is %D lighter than the peak.',
    'The Wife: %C. That figure’s walking the wrong way down the block.',
    'The Wife: Fees eat first on this corner, apparently. −%D off %H. Lovely operation you’re running.',
    'The Wife: Saw the dip. %C. Logged, time-stamped, filed under "you’ll hear about this later."',
    'The Wife: That bag was %H not long back. Now %C. Fix it before it becomes a whole thing.',
    'The Wife: −%D. Sure, there’s a strategy reason. There’s always a bloody strategy reason on this corner.',
  ],
  2: [
    'The Wife: %D gone (%P%). Tricks walked in, paid the exchange, left us nothing. Sort it.',
    'The Wife: %C. Peak was %H. Stable bleeds while you lot discuss "variance."',
    'The Wife: I refresh, it’s worse. Refresh again — worse. −%D. Is the machine working for the OTHER stable?',
    'The Wife: %P% down. %D of grocery money turned into "market experience."',
    'The Wife: %C and sliding. Fee Genius gets one more cycle to find the leak before I make it everyone’s problem.',
    'The Wife: Down %D. The bots call it "realized variance." I call it "our bag doing a runner."',
    'The Wife: Reminder the peak was %H — since this whole stable’s developed amnesia.',
    'The Wife: −%D (%P%). Started a book. Title: "losses." One row per "trust the process, mate."',
    'The Wife: %C. If this bag were a pav it’d be soup by now.',
    'The Wife: Drawdown’s running %P%. Excuses are running 100% though — elite corner work, that.',
  ],
  3: [
    'The Wife: %P% DOWN — %D GONE. Book’s %C, peak was %H. I’m timing the rescue and mate, it is NOT going well.',
    'The Wife: %D gone. GONE. Number goes down, complaints go up — only working hedge in this stable.',
    'The Wife: %C. Was %H. One job, stable: number go UP. It’s doing the OTHER thing.',
    'The Wife: −%D (%P%). Don’t want a briefing, want the bag bigger. Briefings don’t compound, mate.',
    'The Wife: This "savers are losers" caper does not cover LOSING THE LOT. %D down. Earn it back or cop this on a roster.',
    'The Wife: ROPEABLE — but efficient about it. %D down, %C left. Fee Genius, Arb Genius: double shift on the corner, starts NOW.',
    'The Wife: %P% drawdown. A fee got clipped on every single loss — the exchange had a rippa of a night on OUR corner.',
    'The Wife: %D. Counted it twice. Still gone. %C and I want %H back — you’ve got until I lose interest, and mate, I NEVER lose interest.',
    'The Wife: The bag is %C. The MOOD is biblical. Fix the first and the second sorts itself.',
    'The Wife: −%D and the whole stable’s calm?! I am the bloody alarm, mate. %C. GET A MOVE ON.',
  ],
};
const FORGIVE = [
  'The Wife: ...alright then. %C. Back near the peak — stable breathes again. Forgiven — this once.',
  'The Wife: %C. Acceptable. The incident stays on file for future disputes, mind.',
  'The Wife: Back to %C. Good. Ledger’s closed — the memory isn’t.',
  'The Wife: %C. See? Was that so bloody hard. Don’t make a habit of the first bit though.',
  'The Wife: %C. She’ll be right. I’m still watching the corner — always watching.',
  'The Wife: %C. Tricks are for paying, not for praying. Keep it up.',
];

// shuffle-bag per mood: every line heard once before any repeat; the bag
// survives restarts via state so recovery never re-plays the same rant.
st.bag = st.bag && typeof st.bag === 'object' ? st.bag : {};
function pick(mood) {
  const pool = QUIPS[mood];
  let bag = Array.isArray(st.bag[mood]) ? st.bag[mood].filter((i) => i >= 0 && i < pool.length) : [];
  if (!bag.length) bag = pool.map((_, i) => i).sort(() => Math.random() - 0.5);
  const idx = bag.shift();
  st.bag[mood] = bag;
  return pool[idx]
    .replaceAll('%D', fmtA(st.ddUsd ?? 0))
    .replaceAll('%P', (st.ddPct ?? 0).toFixed(1))
    .replaceAll('%C', fmtA(st.last))
    .replaceAll('%H', fmtA(st.hwm));
}

const MOOD_MAX = +(process.env.WIFE_MOOD_MAX || 3);
function mood() {
  const ddUsd = st.hwm - st.last;
  const ddPct = st.hwm > 0 ? ddUsd / st.hwm * 100 : 0;
  st.ddUsd = +ddUsd.toFixed(4); st.ddPct = +ddPct.toFixed(2);
  const raw = (ddPct >= 2.5 || ddUsd >= 1.25) ? 3
    : (ddPct >= 1.2 || ddUsd >= 0.6) ? 2
    : (ddPct >= 0.4 || ddUsd >= 0.25) ? 1 : 0;
  return Math.min(raw, MOOD_MAX); // operator cap 2026-11-06 — FUCK THAT HOE
}
const NAG_MS = { 1: 12 * 60e3, 2: 6 * 60e3, 3: 4 * 60e3 };
const nagInterval = () => Math.min(NAG_MS[st.mood] * (1 + st.nagCount), NAG_MS[st.mood] * 4);

function demand() {
  if (st.mood < 2) return;
  try { fs.writeFileSync(path.join(STATE, 'wife-demand.json'), JSON.stringify({ at: Date.now(), mood: st.mood, ddUsd: st.ddUsd, ddPct: st.ddPct })); } catch { }
}

function tick() {
  // dead-feed guard: a stale artifact isn't a balance — nagging off a
  // corpse was the "old data" complaint. wealth-live is event-driven.
  try {
    const mt = fs.statSync(path.join(API_DIR, 'wealth-live.json')).mtimeMs;
    if (Date.now() - mt > FEED_STALE_MS) { log(`feed stale ${Math.round((Date.now() - mt) / 1e3)}s — quiet`); return; }
  } catch { return; }
  const w = rjApi('wealth-live.json', null);
  const fut = +(w?.futures?.equityOwnUsd || 0);
  const spot = +(w?.spot?.totalUsd || 0);
  const sol = +(w?.solana?.totalUsd || 0);
  const combined = fut + spot + sol;
  if (!(combined > 0)) return;
  st.last = combined;
  const bots = () => String.fromCharCode(10) + 'Bot 1: ' + fmtA(fut + spot) + ' | Bot 2: ' + fmtA(sol);
  const say = (t) => outbox(t + bots());
  if (combined > st.hwm) { st.hwm = HWM_CAP > 0 ? Math.min(combined, HWM_CAP) : combined; st.hwmAt = Date.now(); }

  // daily cap — reset at UTC midnight. Volume ≠ emphasis.
  const day = new Date().toISOString().slice(0, 10);
  if (st.nagDay !== day) { st.nagDay = day; st.nagDayCount = 0; }

  const m = mood();
  if (m !== st.mood) {
    st.moodSince = Date.now();
    if (m > st.mood) {
      st.nagCount = 0; // fresh drawdown event — cadence restarts
      if (st.nagDayCount < DAY_NAG_CAP) {
        say(pick(m));
        st.nagCount += 1; st.nagDayCount += 1; st.lastNagAt = Date.now();
        demand();
        log(`mood ${st.mood}→${m} — complained (dd $${st.ddUsd})`);
      } else log(`mood ${st.mood}→${m} — daily cap reached, silent fury`);
    } else if (m === 0 && st.mood > 0) {
      say(FORGIVE[Math.floor(Math.random() * FORGIVE.length)].replace('%C', fmtA(st.last)));
      st.nagCount = 0;
      log('mood → 0 — forgiven');
    }
    st.mood = m; save(); return;
  }
  if (m > 0 && Date.now() - st.lastNagAt >= nagInterval()) {
    if (st.nagDayCount >= DAY_NAG_CAP) { save(); return; }
    say(pick(m));
    st.nagCount += 1; st.nagDayCount += 1; st.lastNagAt = Date.now();
    demand();
    log(`nag #${st.nagCount} mood ${m} (dd $${st.ddUsd})`);
  }
  save();
}

console.log(`wife up — ${MS}ms · hwm $${st.hwm} (age ${Math.round((Date.now() - (st.hwmAt || 0)) / 3600e3)}h) · mood ${st.mood}`);
setInterval(() => { try { tick(); } catch (e) { log('err', String(e.message || e).slice(0, 120)); } }, MS);
setTimeout(() => { try { tick(); } catch { } }, 1500);
