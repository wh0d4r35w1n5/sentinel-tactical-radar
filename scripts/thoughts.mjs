// thoughts.mjs — the bot's inner voice, in plain english.
// Runs last in the rapid loop. Reads every artifact and answers one
// question per cycle: "what is the bot doing right now, and why?"
// Output: api/thoughts.json — { at, mood, headline, now[], feed[] }
// Everything must be understandable by someone who has never traded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = path.join(__dirname, '..', 'api');
const STATE = path.join(API, '..', 'state', 'thoughts-state.json');
const NOW = Date.now();

const rj = (f) => { try { return JSON.parse(fs.readFileSync(path.join(API, f), 'utf8')); } catch { return null; } };
const $ = (v, d = 2) => v == null ? '—' : '$' + Number(v).toFixed(d);
const sym = (s) => (s || '').replace(/USDT$/, '');
const pctS = (v) => (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%';
const agoMin = (ts) => { const m = Math.round((NOW - ts) / 6e4); return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : Math.round(m / 60) + 'h ago'; };

const ll = rj('live-ledger.json');
const plan = rj('live-plan.json');
const taken = rj('trades-taken.json');
const god = rj('god.json');
const scan = rj('market-scanner.json');

// ---- ELI5 translation tables ----
// every gate the engine uses → one honest plain-english reason
const GATE = [
  [/already-open/i, 'we already hold this one'],
  [/proxy-dup|clustered/i, 'too similar to something we already hold — same bet twice'],
  [/score \d+<\d+/i, (g) => { const m = g.match(/score (\d+)<(\d+)/i); return `the setup scored ${m[1]}, we need ${m[2]} — not strong enough`; }],
  [/rr<[\d.]+.*tgt ([\d.]+)%/i, (g) => { const m = g.match(/tgt ([\d.]+)%/i); return `the win was only ${m[1]}% — not worth the risk` }],
  [/rr<[\d.]+/i, 'the possible win was too small next to the risk'],
  [/shorts-banned/i, 'it was a bet on prices falling — we only bet on rising'],
  [/fake-move/i, 'it looked like a pump with no real buyers behind it — a trap'],
  [/low-profit-pair/i, 'we lost money on this market before — it is benched'],
  [/cooldown|re-entry/i, 'cooling off — this one stung us recently'],
  [/strat-blocked|sqn-chain/i, 'this play has a losing track record right now'],
  [/noise-cap|noise/i, 'the market is too random right now to read'],
  [/manual-hold/i, 'hands-off — the operator holds this one personally'],
  [/duplicate|idempotent/i, 'same signal twice — ignored the replay'],
  [/protection-halt/i, 'paused — safety-net placement failed earlier, no naked entries'],
  [/rate cap|entries/i, 'too many trades already today — pacing ourselves'],
  [/fee-burn|fee/i, 'fees already cost too much today — standing down'],
  [/kill-switch|dd-kill|drawdown/i, 'safety brake — account dropped too far'],
  [/stale|ttl|ran/i, 'the signal went stale before we could act'],
  [/untradeable|catalog|minimum|margin/i, 'too small or unavailable to trade here'],
];
const plainGate = (g) => {
  for (const [re, f] of GATE) if (re.test(g)) return typeof f === 'function' ? f(g) : f;
  return 'it did not pass the safety checks';
};
const plainSym = (s) => sym(s);

// event strings → plain sentences
const ACT = [
  [/core-carry: deploying \$([\d.]+) idle margin into (\w+)/i, (m) => `Put $${m[1]} of spare cash to work buying ${sym(m[2])} — idle money doesn't sit around here`],
  [/opened (\w+) (LONG|SHORT) ([\d.]+) @~([\d.]+) lev (\d+)x margin \$([\d.]+) notional \$([\d.]+)/i, (m) => `Just bought ${sym(m[1])} — put $${m[6]} down at ${m[5]}x, betting $${m[7]} it goes ${m[2] === 'LONG' ? 'up' : 'down'}`],
  [/closed (\w+) (long|short) ([\d.]+)/i, (m) => `Closed the ${sym(m[1])} trade`],
  [/flatten: closed (\w+)/i, (m) => `Operator said get out — closed ${sym(m[1])} immediately`],
  [/decay-exit (\w+).*uPnL ([\-\d.]+)%/i, (m) => `Closed ${sym(m[1])} — it was ${m[2]}% down and the idea went stale`],
  [/thesis-flip (\w+): fresh (\w+) signal vs open (\w+)/i, (m) => `Closed ${sym(m[1])} — a fresh ${m[2].toLowerCase()} signal says the idea is dead`],
  [/rebalanced (\w+): closed ([\d.]+)\//i, (m) => `Trimmed ${sym(m[1])} — it was hogging too much of the account`],
  [/protected (\w+)/i, (m) => `Added a safety net on ${sym(m[1])}`],
  [/close (\w+) ignored — position (\d+)s old/i, (m) => `Refused to close ${sym(m[1])} seconds after opening — protection stands`],
  [/duplicate signal — idempotent skip/i, (m) => `Same signal twice — ignored the replay`],
  [/repaired (\w+): added pos_loss/i, (m) => `Safety check — ${sym(m[1])} had no emergency exit, put one in at the right level`],
  [/repaired (\w+): TP ladder/i, (m) => `Rebuilt ${sym(m[1])}'s profit targets — they were missing or wrong`],
  [/repaired (\w+)/i, (m) => `Fixed ${sym(m[1])}'s protection — it wasn't fully covered`],
  [/clamped (\w+) synth stop ([\d.]+)% -> ([\d.]+)%/i, (m) => `Moved ${sym(m[1])}'s safety net further out — it was sitting too close to forced-exit territory`],
  [/pos_loss .* (\w+) .*@ ([\d.]+)/i, (m) => `Set ${sym(m[1])}'s safety net at ${m[2]} — automatic exit if it falls that far`],
  [/reduce-only.*(\w+)/i, (m) => `Sent a shrink order on ${sym(m[1])} — trimming, not adding`],
  [/cooldown (\w+)/i, (m) => `${sym(m[1])} is cooling off — gave it a breather, will look again soon`],
  [/rate limit|too many orders/i, () => `Exchange asked us to slow down — waiting a moment`],
];
const plainAct = (a) => {
  for (const [re, f] of ACT) if (re.test(a)) return f(a.match(re));
  if (/insufficient free margin/i.test(a)) return null; // routine, not news
  if (/net R:R .*< .* after costs — rejected/i.test(a)) {
    const m = a.match(/^(\w+): net R:R ([\d.]+) < ([\d.]+)/i);
    return m ? `Skipped ${sym(m[1])} — could only make ${m[2]} for every 1 risked (we want ${m[3]})` : null;
  }
  if (/SHORT blocked/i.test(a)) { const m = a.match(/^(\w+)/); return `Skipped ${sym(m[1])} — a bet on falling prices, we only bet on rising`; }
  return null; // unknown actions aren't shown — never fake a translation
};

// ---------- load prior feed, diff actions for new events ----------
let st = { seenActs: [], feed: [] };
try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
const seen = new Set(st.seenActs || []);
const feed = st.feed || [];
const pushFeed = (icon, text) => { if (text) feed.unshift({ icon, text, ts: NOW }); };

// new executor actions → feed events
for (const a of (ll?.actions || []).slice().reverse()) {
  if (seen.has(a)) continue;
  seen.add(a);
  const t = plainAct(a);
  if (t) pushFeed(/opened|core-carry/i.test(a) ? '🟢' : /closed|flatten|decay|flip|rebalance|reduce-only/i.test(a) ? '🔴' : '🛡️', t);
}
// god interventions → feed events
for (const iv of (god?.interventions || [])) {
  const key = 'god:' + iv.what + iv.at;
  if (seen.has(key)) continue;
  seen.add(key);
  pushFeed('👁️', `Overseer stepped in — ${iv.what}: ${iv.res}`);
}

// ---------- NOW: positions, in plain words ----------
const now = [];
const positions = ll?.positions || ll?.positionsAfter || [];
const plans = ll?.plans || {};
for (const p of positions) {
  const side = (p.side || p.holdSide) === 'long' ? 'LONG' : 'SHORT';
  const lev = +(p.lev || p.leverage || 1);
  const margin = p.size && p.entry && lev ? (p.size * p.entry) / lev : null;
  const upl = +(p.upl ?? p.unrealizedPL ?? 0);
  const pl = plans[p.symbol] || [];
  const sl = pl.filter((x) => /loss|moving/i.test(x.planType || '')).map((x) => +x.triggerPrice).filter(Number.isFinite);
  const tp = pl.filter((x) => /profit/i.test(x.planType || '')).map((x) => +x.triggerPrice).filter(Number.isFinite);
  const dir = side === 'LONG' ? 'up' : 'down';
  let s = `Holding ${sym(p.symbol)} ${side.toLowerCase()} — we bet it goes ${dir}. `;
  if (margin) s += `$${margin.toFixed(2)} on it, `;
  s += `${upl >= 0 ? 'up' : 'down'} $${Math.abs(upl).toFixed(2)} right now. `;
  if (sl.length) s += `If price hits ${Math.min(...sl)} we're automatically out (the safety net). `;
  if (tp.length) s += `If it climbs past ${Math.max(...tp)} we start banking profit in chunks.`;
  if (!sl.length) s += `⚠️ No safety net detected — overseer should be fixing this.`;
  now.push({ icon: upl >= 0 ? '📈' : '📉', text: s });
}

// ---------- NOW: what we're watching / skipping ----------
const rejects = plan?.rejects || [];
if (rejects.length) {
  const top = rejects.slice(0, 4).map((r) =>
    `${sym(r.symbol)} — ${plainGate((r.gates || [])[0] || '')}`);
  now.push({
    icon: '⏭️',
    text: `Skipped ${rejects.length} possible trades this minute. ` +
      top.join(' · ') + (rejects.length > 4 ? ` · and ${rejects.length - 4} more that also failed the checks.` : ' Nothing worth risking money on yet.'),
  });
}
const orders = plan?.orders || [];
if (orders.length) {
  for (const o of orders.slice(0, 3))
    now.push({
      icon: '🎯',
      text: `Lining up ${sym(o.symbol)} ${o.direction.toLowerCase()} — waiting for the moment to commit`,
    });
}

// ---------- last real trade ----------
const closed = (taken?.trades || []).filter((t) => t.status !== 'open').sort((a, b) => b.exitTs - a.exitTs)[0];
const ckey = closed ? 'closed:' + closed.symbol + closed.exitTs : null;
if (closed && NOW - closed.exitTs < 6 * 3600e3 && !seen.has(ckey)) {
  seen.add(ckey);
  pushFeed(closed.net >= 0 ? '💰' : '🩸',
    `Last real trade: ${sym(closed.symbol)} ${closed.dir.toLowerCase()} — ${closed.net >= 0 ? 'won' : 'lost'} $${Math.abs(closed.net).toFixed(2)}`);
}

// ---------- mood + headline ----------
const llAge = ll?.refreshedAt ? NOW - new Date(ll.refreshedAt).getTime() : Infinity;
const llStale = !ll || llAge > 3 * 60e3;
if (llStale)
  now.unshift({ icon: '⚠️', text: 'The bot\'s status feed went quiet — this could be a stale snapshot, not the live truth' });
const uplSum = positions.reduce((a, p) => a + (+(p.upl ?? 0)), 0);
const fails = (god?.checks || []).filter((c) => c.status === 'FAIL');
let mood;
if (llStale) mood = 'FIXING';
else if (fails.length) mood = 'FIXING';
else if (!positions.length) mood = 'WATCHING';
else if (uplSum > 0.5) mood = 'WINNING';
else if (uplSum < -0.5) mood = 'BLEEDING';
else mood = 'CALM';

const openCount = positions.length;
const freeUsd = ll?.marginFreeUsd;
const sigCount = (scan?.signals || []).length;
let headline;
if (llStale)
  headline = 'The bot went quiet — its status feed is missing or stale right now';
else if (fails.length)
  headline = `Heads up — the overseer flagged ${fails.length} problem${fails.length > 1 ? 's' : ''} and is on it`;
else if (openCount)
  headline = `Holding ${openCount} trade${openCount > 1 ? 's' : ''} (${uplSum >= 0 ? 'up' : 'down'} $${Math.abs(uplSum).toFixed(2)} combined) — every position has a safety net · watching ${sigCount} more setups for the next shot`;
else
  headline = `No trades open right now — watching ${sigCount} markets and waiting for a setup worth the risk`;

// ---------- write ----------
const out = {
  at: NOW,
  mood,
  headline,
  now,
  feed: feed.filter((t, i) => feed.findIndex((x) => x.text === t.text) === i).slice(0, 30),
};
fs.writeFileSync(path.join(API, 'thoughts.json.tmp'), JSON.stringify(out));
fs.renameSync(path.join(API, 'thoughts.json.tmp'), path.join(API, 'thoughts.json'));
fs.writeFileSync(STATE, JSON.stringify({ seenActs: [...seen].slice(-500), feed: feed.slice(0, 60) }));
console.log(`[thoughts] ${mood} — ${headline.slice(0, 90)}`);
