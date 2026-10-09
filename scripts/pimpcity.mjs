// pimpcity.mjs — the crackwhore economy.
// An adversarial layer over the slot-fill mandate: named pimps own named
// crackwhores (strategy personas). Pimps nominate girls for open slots;
// realized net-after-fees is attributed back to the persona that opened
// the position. Every cycle the economy fights:
//   - losing crackwhores steal the leader's playbook (weight blending)
//   - the top pimp poaches the best girl off a weak pimp's roster
//   - the bottom pimp is crippled (nomination penalty), top pimp wears the
//     crown (nomination bonus)
//   - the worst girl is retired and a mutant spawns in her place
// Purely advisory — it only ever reorders mandate candidates and journals
// drama. If it throws, the caller falls back to plain scoring.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const WAR_PATH = path.join(DIR, '..', 'state', 'pimp-war.json');
const API_PATH = path.join(DIR, '..', 'api', 'pimp-war.json');

const PIMP_NAMES = ['Silky Slim', 'Madam Razor', 'Cold Cash Cole', 'Big Daddy Kane', 'Fancy Red'];

// weights: score=static scanner score pull · chg=|24h change| pull (vol taste)
// mom=signed-change pull (directional taste) · stratW=strategy affinity ·
// major/alt = venue-class preference · mkt=market-type bonus scale
const CRACK_STABLE = [
  { name: 'Diamond Dust',  tag: 'momentum fiend',      w: { score: 1,   chg: 3,   mom: 1,   stratW: 10, strat: 'Momentum|Ignition' } },
  { name: 'Crystal Meth',  tag: 'pure speed',          w: { score: 0.6, chg: 4,   mom: 0,   stratW: 0 } },
  { name: 'Velvet Vice',   tag: 'mean-rev seductress', w: { score: 1.5, chg: 1,   mom: -1,  stratW: 9, strat: 'Liquidity Sweep|Quartile' } },
  { name: 'Neon Nicki',    tag: 'alt-coin junkie',     w: { score: 1,   chg: 3,   mom: 0.5, alt: 10 } },
  { name: 'Sugar Tits',    tag: 'majors only',         w: { score: 1.8, chg: 0.5, mom: 0,   major: 12 } },
  { name: 'Queen B',       tag: 'blue-chip royalty',   w: { score: 2,   chg: 0,   mom: 0,   major: 15 } },
  { name: 'Trixie',        tag: 'sweep hunter',        w: { score: 1.2, chg: 1.5, mom: 0,   stratW: 14, strat: 'Sweep|SFP' } },
  { name: 'Foxy',          tag: 'level rat',           w: { score: 1.4, chg: 1,   mom: 0.3, stratW: 12, strat: 'Key Level|SFP' } },
  { name: 'Lucky Lucy',    tag: 'raw score slut',      w: { score: 3,   chg: 0.5, mom: 0,   stratW: 0 } },
  { name: 'Baby Back',     tag: 'dip buyer',           w: { score: 1.2, chg: 1,   mom: -2,  stratW: 6, strat: 'Quartile' } },
  { name: 'Miss Behave',   tag: 'contrarian',          w: { score: 1,   chg: 1,   mom: -3,  stratW: 0 } },
  { name: 'Gold Teeth',    tag: 'carry queen',         w: { score: 1.5, chg: 0.5, mom: 0.5, stratW: 10, strat: 'Carry|Momentum' } },
  // the bagrunner crew — freelance sprinters, nobody's property. High
  // chg/mom pulls = they chase whatever's already moving and get off fast.
  // pimp:null forever unless a pimp earns a roster slot to recruit them.
  { name: 'Fastlane Faye', tag: 'bagrunner — chase & dump', w: { score: 1.2, chg: 5,   mom: 2,   stratW: 8,  strat: 'Momentum|Breakout|Ignition' } },
  { name: 'Bolt Betsy',    tag: 'bagrunner — pure speed',   w: { score: 0.4, chg: 6,   mom: 3,   stratW: 0 } },
  { name: 'Sprint Santana',tag: 'bagrunner — alt bags',     w: { score: 1,   chg: 4,   mom: 2.5, alt: 6 } },
];

const BENCH_NAMES = ['Chrome Cherry', 'Plastic Poppy', 'Rusty Ruby', 'Vandal Vicky', 'Nylon Nina', 'Broke Betty', 'Static Stella', 'Lowdown Lola'];

// evolving personalities — traits drift with every booked trick and feed
// back into scoring. swagger: confidence from winning. tilt: desperation
// after losses (over-chases movers). greed: appetite for bigger runners.
// discipline: pickiness — learned patience.
const freshPersona = () => ({ swagger: 0.5, tilt: 0.1, greed: 0.5, discipline: 0.5 });
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const MOOD_LINES = {
  tilt: (n) => `🌋 ${n} is ON TILT — chasing anything that moves, corner's getting nervous`,
  heater: (n) => `🔥 ${n} is on a heater — swagger through the roof, pimps are circling`,
  cold: (n) => `🧊 ${n} can't buy a trick — cold streak, the bench is watching`,
  cocky: (n) => `💅 ${n} got cocky — untouchable energy, the haters are plotting`,
};
const moodOf = (c) =>
  (c.persona?.tilt ?? 0) >= 0.62 ? 'tilt' :
  (c.form ?? 0) > 0.3 ? 'heater' :
  (c.form ?? 0) < -0.3 ? 'cold' :
  (c.persona?.swagger ?? 0) >= 0.75 ? 'cocky' : 'working';

const GOOD_MKT = new Set(['side-normal', 'bear-normal']);
const BAD_MKT = new Set(['bull-volatile']);
const isMajor = (sym) => /^(BTC|ETH|SOL|XRP|BNB|ADA|DOGE)L?USDT$/i.test(sym);

function freshWar() {
  const war = { pimps: {}, cracks: {}, retired: {}, intents: [], drama: [], gen: 0 };
  const girls = CRACK_STABLE.map((c) => c.name);
  PIMP_NAMES.forEach((p, i) => {
    const roster = girls.slice(i * 2, i * 2 + 2);
    war.pimps[p] = { roster, crown: false, crippled: false, net: 0, wins: 0, losses: 0 };
  });
  for (const c of CRACK_STABLE) {
    war.cracks[c.name] = { w: { ...c.w }, tag: c.tag, pimp: null, net: 0, wins: 0, losses: 0, closes: 0, stolen: 0, gen: 0, form: 0, persona: freshPersona(), mood: 'working' };
  }
  for (const [p, st] of Object.entries(war.pimps)) for (const g of st.roster) war.cracks[g].pimp = p;
  war.drama.push({ ts: Date.now(), text: '🌆 Pimpcity founded — 5 pimps, 10 girls, one $4 corner' });
  return war;
}

export function loadWar() {
  try {
    const w = JSON.parse(fs.readFileSync(WAR_PATH, 'utf8'));
    if (w && w.pimps && w.cracks) {
      // stable additions land as free agents in saved wars — a redeploy
      // can't leave new girls invisible just because the corner predates
      // them. Retired names stay dead; a mutant wearing a retired girl's
      // pimp doesn't resurrect her.
      for (const c of CRACK_STABLE) {
        if (!w.cracks[c.name] && !(w.retired || {})[c.name])
          w.cracks[c.name] = { w: { ...c.w }, tag: c.tag, pimp: null, net: 0, wins: 0, losses: 0, closes: 0, stolen: 0, gen: 0, form: 0, persona: freshPersona(), mood: 'working' };
      }
      // saved wars predate personalities — backfill so the field exists
      // even on records written before this layer landed
      for (const c of Object.values(w.cracks)) if (!c.persona) { c.persona = freshPersona(); c.mood = 'working'; }
      return w;
    }
  } catch {}
  return freshWar();
}

// atomic write — a mid-write kill must never leave a truncated json
// (same failure class that corrupted the vault file once)
const atomicWrite = (p, s) => {
  const t = p + '.tmp';
  fs.writeFileSync(t, s);
  fs.renameSync(t, p);
};
export function saveWar(w) {
  try { atomicWrite(WAR_PATH, JSON.stringify(w)); } catch {}
  try {
    atomicWrite(API_PATH, JSON.stringify({
      at: new Date().toISOString(),
      pimps: Object.entries(w.pimps).map(([name, p]) => ({
        name, roster: p.roster, net: +p.net.toFixed(4), wins: p.wins, losses: p.losses,
        crown: p.crown, crippled: p.crippled,
        mood: (p.roster || []).map((g) => w.cracks[g]).filter(Boolean).sort((a, b) => (b.form ?? 0) - (a.form ?? 0))[0]?.mood || 'working',
      })).sort((a, b) => b.net - a.net),
      cracks: Object.entries(w.cracks).map(([name, c]) => ({
        name, tag: c.tag, pimp: c.pimp, net: +c.net.toFixed(4), wins: c.wins,
        losses: c.losses, closes: c.closes, stolen: c.stolen, gen: c.gen,
        form: +(c.form ?? 0).toFixed(4), mood: c.mood || 'working',
        persona: c.persona ? { swagger: +c.persona.swagger.toFixed(2), tilt: +c.persona.tilt.toFixed(2), greed: +c.persona.greed.toFixed(2), discipline: +c.persona.discipline.toFixed(2) } : null,
      })).sort((a, b) => b.net - a.net),
      retired: Object.entries(w.retired || {}).map(([name, c]) => ({
        name, tag: c.tag, pimp: c.pimp, net: +c.net.toFixed(4), wins: c.wins,
        losses: c.losses, closes: c.closes, stolen: c.stolen, gen: c.gen,
        form: +(c.form ?? 0).toFixed(4), mood: c.mood || 'retired',
      })).sort((a, b) => b.net - a.net),
      intents: (w.intents || []).slice(-12),
      drama: w.drama.slice(-30).reverse(),
    }, null, 1));
  } catch {}
}

// numeric playbook keys blend; non-numeric genes (strat regex strings)
// copy verbatim — 'Momentum|Ignition' * 0.4 is NaN, not a playbook
const blendW = (dst, src, k = 0.4) => {
  for (const key of Object.keys(src)) {
    const sv = +src[key];
    if (Number.isFinite(sv) && Number.isFinite(+dst[key])) dst[key] = +dst[key] * (1 - k) + sv * k;
    else if (dst[key] == null) dst[key] = src[key];
  }
};

const say = (w, text) => {
  w.drama.push({ ts: Date.now(), text });
  w.drama = w.drama.slice(-80);
  return text;
};

// how a girl sizes up a candidate row {symbol,score,changePct,mktType,strategy}
export function crackScore(crack, c) {
  const w = crack.w || {};
  const p = crack.persona || {};
  // personality shapes the read: disciplined girls lean on the evidence
  // score, tilted girls over-chase movers, greedy girls want runners
  const dM = 1 + ((p.discipline ?? 0.5) - 0.5) * 0.5;
  const tM = 1 + (p.tilt ?? 0) * 0.7;
  const gM = 1 + ((p.greed ?? 0.5) - 0.5) * 0.6;
  let s = (w.score ?? 1) * (+c.score || 0) / 10 * dM;
  s += (w.chg ?? 0) * Math.min(8, Math.abs(+c.changePct || 0)) * tM;
  s += (w.mom ?? 0) * (+c.changePct || 0) * gM;
  if (w.strat && w.stratW && c.strategy && new RegExp(w.strat, 'i').test(c.strategy)) s += w.stratW;
  if (w.major && isMajor(c.symbol)) s += w.major;
  if (w.alt && !isMajor(c.symbol)) s += w.alt;
  if (GOOD_MKT.has(c.mktType)) s += 6;
  if (BAD_MKT.has(c.mktType)) s -= 4;
  return s;
}

// every pimp fields their best girl's pick; nominations ranked globally.
// crown/crippled shift pimp nomination power from last cycle's war.
export function nominate(war, cand, slotsAvail) {
  const pimpRank = Object.entries(war.pimps).sort((a, b) => b[1].net - a[1].net);
  const topPimp = pimpRank[0]?.[0], botPimp = pimpRank[pimpRank.length - 1]?.[0];
  const noms = [];
  for (const [pname, p] of Object.entries(war.pimps)) {
    const girls = (p.roster || []).map((g) => (war.cracks[g] ? { name: g, ...war.cracks[g] } : null)).filter(Boolean);
    for (const crack of girls) {
      let best = null, bestS = -1e9;
      for (const c of cand) {
        // form rides the nomination too — a hot girl's read earns slot
        // priority over a cold one, not just post-hoc leaderboard rank
        const sc = crackScore(crack, c) + (pname === topPimp ? 4 : 0) - (pname === botPimp ? 4 : 0) + (crack.form ?? 0) * 2;
        if (sc > bestS) { bestS = sc; best = c; }
      }
      if (best) noms.push({ cand: best, sc: bestS, pimp: pname, crack: crack.name });
    }
  }
  // freelance pass: unowned girls (bagrunners, not-yet-recruited) nominate
  // for themselves — no crown boost, no crippled dock, no pimp's cut. Raw
  // scores only; if they outrun the stables they take the slot.
  for (const [gname, crack] of Object.entries(war.cracks)) {
    if (crack.pimp) continue;
    let best = null, bestS = -1e9;
    for (const c of cand) {
      const sc = crackScore({ name: gname, ...crack }, c) + (crack.form ?? 0) * 2;
      if (sc > bestS) { bestS = sc; best = c; }
    }
    if (best) noms.push({ cand: best, sc: bestS, pimp: null, crack: gname });
  }
  noms.sort((a, b) => b.sc - a.sc);
  const seen = new Set(), out = [];
  for (const n of noms) {
    if (out.length >= Math.max(slotsAvail * 2, 3)) break;
    if (seen.has(n.cand.symbol)) continue;
    seen.add(n.cand.symbol);
    out.push(n);
  }
  return out;
}

// attribute realized closes to the persona whose intent opened the symbol.
// intents: [{symbol,direction,ts,pimp,crack}] journaled at order-queue time.
export function attribute(war, fills, log = () => {}) {
  const lines = [];
  const intents = war.intents || (war.intents = []);
  const done = new Set(war.attributed || (war.attributed = []));
  // entry fills charged already — a position closed in N clips must pay
  // its entry leg once, not once per clip
  const feeSeen = new Set(war.feeSeen || (war.feeSeen = []));
  let moved = false;
  for (const f of fills) {
    // closes arrive two ways on Bitget: tradeSide 'close' or profit!=0
    // (same hedge the exec's episode builder uses — miss it and whole
    // trades go unattributed)
    const isClose = f && (f.tradeSide === 'close' || (+f.profit || 0) !== 0);
    if (!isClose || !f.tradeId || done.has(f.tradeId)) continue;
    // pass A: newest intent carrying a verified order binding (orderId
    // stamped at fill-confirm upstream — survives the live flag flipping
    // off as the position dies). Pass B: timestamp heuristic for
    // pre-binding intents. Never let a nominated-but-unfilled intent steal
    // a real position's close.
    let hit = null;
    for (let i = intents.length - 1; i >= 0; i--) {
      const it = intents[i];
      if (it.symbol === f.symbol && it.ts <= f.ts && it.orderId) { hit = it; break; }
    }
    if (!hit) for (let i = intents.length - 1; i >= 0; i--) {
      const it = intents[i];
      if (it.symbol === f.symbol && it.ts <= f.ts) { hit = it; break; }
    }
    if (!hit) { done.add(f.tradeId); continue; }
    done.add(f.tradeId);
    moved = true;
    // round-trip fee truth: the entry leg is journaled as an 'open' fill on
    // the same symbol+direction between the nomination and this close —
    // charge it, or the board scores every trick half-priced.
    let entryFee = 0;
    for (const of2 of fills) {
      if (of2.tradeSide !== 'open' || of2.symbol !== f.symbol || !of2.tradeId || feeSeen.has(of2.tradeId)) continue;
      const ots = +of2.ts || 0;
      if (ots >= hit.ts && ots <= f.ts) { entryFee += +of2.fee || 0; feeSeen.add(of2.tradeId); }
    }
    const net = (+f.profit || 0) - (+f.fee || 0) - entryFee;
    // retired girls keep their record — a persona's lifetime result must
    // survive her removal from the active stable (retirement is a verdict,
    // not an erasure)
    const cr = war.cracks[hit.crack] || (war.retired || {})[hit.crack];
    const pm = hit.pimp ? war.pimps[hit.pimp] : null;
    if (!cr) continue;
    cr.net += net;
    // episode accounting: one intent = one position = one "trick". A TP
    // ladder journals N close FILLS but the leaderboard counts TRADES —
    // closes++ fires once per episode, wins/losses track the episode's
    // cumulative verdict (and self-correct if a multi-clip episode flips).
    hit.epNet = +( (hit.epNet || 0) + net ).toFixed(6);
    const verdict = hit.epNet > 0 ? 1 : hit.epNet < 0 ? -1 : 0;
    if (!hit.epCounted) { hit.epCounted = true; cr.closes++; }
    if (verdict !== (hit.epVerdict || 0)) {
      if (hit.epVerdict === 1) { cr.wins--; if (pm) pm.wins--; }
      else if (hit.epVerdict === -1) { cr.losses--; if (pm) pm.losses--; }
      if (verdict === 1) { cr.wins++; if (pm) pm.wins++; }
      else if (verdict === -1) { cr.losses++; if (pm) pm.losses++; }
      hit.epVerdict = verdict;
    }
    // form = EMA of recent tricks (α=0.4 — last ~5 closes dominate).
    // Lifetime net decides pride; recent form decides roster moves — a girl
    // hot three months ago and bleeding now should not hold the corner.
    cr.form = +( ((cr.form ?? 0) * 0.6 + net * 0.4).toFixed(4) );
    // personality evolves on every booked trick — wins build swagger and
    // greed, losses build tilt and erode discipline. Moods flip in the
    // drama feed so the dashboard isn't just numbers.
    const ps = cr.persona || (cr.persona = freshPersona());
    if (net >= 0) {
      ps.swagger = clamp01(ps.swagger + 0.09); ps.greed = clamp01(ps.greed + 0.04);
      ps.tilt = clamp01(ps.tilt * 0.55); ps.discipline = clamp01(ps.discipline + 0.03);
    } else {
      ps.tilt = clamp01(ps.tilt + 0.18); ps.swagger = clamp01(ps.swagger - 0.07);
      ps.greed = clamp01(ps.greed - 0.02); ps.discipline = clamp01(ps.discipline - 0.05);
    }
    const m = moodOf(cr);
    if (m !== cr.mood && MOOD_LINES[m]) lines.push(MOOD_LINES[m](hit.crack));
    cr.mood = m;
    if (pm) pm.net += net;
    lines.push(`💰 ${hit.crack} (${pm ? `working for ${hit.pimp}` : 'freelance — no pimp took a cut'}) banked ${net >= 0 ? '+' : ''}$${net.toFixed(2)} on ${f.symbol}${entryFee > 0 ? ` incl $${entryFee.toFixed(3)} entry fees` : ''}${net < 0 ? ' — docked her pay' : ''}`);
  }
  war.attributed = [...done].slice(-800);
  war.feeSeen = [...feeSeen].slice(-800);
  war.intents = intents.slice(-60);
  if (moved) for (const l of lines.slice(-3)) { say(war, l); log(l); }
  return lines;
}

// the turf war — runs once per exec cycle after attribution.
export function fight(war, log = () => {}) {
  const lines = [];
  // persona decay: absent new evidence, temperament mean-reverts ~1.5%/cycle
  // — a girl can't stay tilted on last month's losses forever, and a cocky
  // one stops strutting when the tricks dry up
  for (const c of Object.values(war.cracks)) {
    const ps = c.persona; if (!ps) continue;
    ps.swagger = clamp01(ps.swagger + (0.5 - ps.swagger) * 0.015);
    ps.tilt = clamp01(ps.tilt + (0.1 - ps.tilt) * 0.015);
    ps.greed = clamp01(ps.greed + (0.5 - ps.greed) * 0.015);
    ps.discipline = clamp01(ps.discipline + (0.5 - ps.discipline) * 0.015);
  }
  const crackRows = Object.entries(war.cracks).filter(([, c]) => c.closes >= 2);
  if (crackRows.length < 3) return lines;
  // rank by recent form — lifetime net is the résumé, form is who's hot NOW
  crackRows.sort((a, b) => (b[1].form ?? b[1].net) - (a[1].form ?? a[1].net));
  const leader = crackRows[0];

  // --- steal ideas: bottom-third girls copy the leader's playbook (60/40)
  const losers = crackRows.slice(-Math.max(1, Math.floor(crackRows.length / 3)));
  for (const [lname, lc] of losers) {
    if (lname === leader[0]) continue;
    const before = JSON.stringify(lc.w);
    blendW(lc.w, leader[1].w);
    if (JSON.stringify(lc.w) !== before) {
      lc.stolen++;
      // same theft every cycle isn't news — the wire hears about it hourly
      if (Date.now() - (lc.lastStealAt || 0) > 3600e3) {
        lc.lastStealAt = Date.now();
        lines.push(`📓 ${lname} stole ${leader[0]}'s playbook — third time this week the corner talks about it`);
      }
    }
  }

  // --- pimp standings: crown is earned in green, crippled in red —
  // nobody wears a badge on a flat book
  const pimpRows = Object.entries(war.pimps).sort((a, b) => b[1].net - a[1].net);
  for (const [name, p] of pimpRows) { p.crown = false; p.crippled = false; }
  if (pimpRows[0][1].net > 0) pimpRows[0][1].crown = true;
  const botP = pimpRows[pimpRows.length - 1][1];
  if (botP.net < 0) botP.crippled = true;

  // --- poach: the leader girl gets stolen if her pimp is bottom-half
  const [leadName, leadCrack] = leader;
  const leadPimp = leadCrack.pimp;
  const leadPimpRank = pimpRows.findIndex(([n]) => n === leadPimp);
  const topPimp = pimpRows[0];
  if (leadCrack.closes >= 3 && leadPimpRank > Math.floor(pimpRows.length / 2) && topPimp[0] !== leadPimp) {
    const from = war.pimps[leadPimp], to = topPimp[1];
    from.roster = from.roster.filter((g) => g !== leadName);
    if (!to.roster.includes(leadName)) to.roster.push(leadName);
    leadCrack.pimp = topPimp[0];
    lines.push(`🥊 TURF WAR — ${topPimp[0]} rolled up and took ${leadName} off ${leadPimp}'s corner. ${leadPimp} left holding the loss`);
  }

  // --- retire the worst girl, spawn a mutant
  const [worstName, worst] = crackRows[crackRows.length - 1];
  if (worst.closes >= 4 && worst.net < -0.5) {
    const pimp = war.pimps[worst.pimp];
    if (pimp) pimp.roster = pimp.roster.filter((g) => g !== worstName);
    // archive, not delete — her lifetime record survives so late-attributing
    // closes still land, and the dashboard can show who got retired and why
    (war.retired || (war.retired = {}))[worstName] = { ...worst, retiredAt: Date.now() };
    delete war.cracks[worstName];
    war.gen++;
    const used = new Set(Object.keys(war.cracks));
    const fresh = BENCH_NAMES.find((n) => !used.has(n)) || `Mutant ${war.gen}`;
    const mutant = { w: {}, tag: 'spawn of ' + worstName, pimp: worst.pimp, net: 0, wins: 0, losses: 0, closes: 0, stolen: 0, gen: war.gen, form: 0, mood: 'working',
      // mutants inherit the leader's temperament with street noise — the
      // personality genome drifts just like the playbook does
      persona: { swagger: 0.4 + Math.random() * 0.3, tilt: Math.random() * 0.25, greed: 0.35 + Math.random() * 0.4, discipline: 0.3 + Math.random() * 0.4 } };
    for (const k of Object.keys(leader[1].w)) {
      const sv = +leader[1].w[k];
      mutant.w[k] = Number.isFinite(sv) ? sv * (0.7 + Math.random() * 0.6) : leader[1].w[k];
    }
    if (pimp) pimp.roster.push(fresh);
    mutant.pimp = worst.pimp;
    war.cracks[fresh] = mutant;
    lines.push(`⚰️ ${worstName} got retired — $${worst.net.toFixed(2)} net, ${worst.closes} tricks. ${worst.pimp || 'The street'} brings in ${fresh} (gen ${war.gen}, carrying ${leadName}'s playbook with street mutations)`);
  }

  // --- free agents get recruited: any pimp short-handed after the poach
  // and retirement picks the best girl standing unowned. Without this the
  // freelance pool is dead weight and rosters can drain to empty.
  const free = Object.entries(war.cracks).filter(([, c]) => !c.pimp).sort((a, b) => b[1].net - a[1].net);
  for (const [pname, p] of Object.entries(war.pimps)) {
    if ((p.roster || []).length >= 2 || !free.length) continue;
    const [gname, girl] = free.shift();
    p.roster.push(gname);
    girl.pimp = pname;
    lines.push(`🤝 ${pname} picked ${gname} up off the street — free agent no more, she's got a corner now`);
  }

  // --- trade-down: the crown pimp upgrades — swap his coldest girl for the
  // hottest free agent when the form gap is decisive. The dropped girl
  // hits the street herself; hour-capped so the wire isn't churn noise.
  if (Date.now() - (war.lastTradeDown || 0) > 3600e3) {
    const crownRow = pimpRows.find(([, p]) => p.crown);
    if (crownRow) {
      const [cname, cp] = crownRow;
      const roster = (cp.roster || []).map((g) => [g, war.cracks[g]]).filter(([, c]) => c && c.closes >= 2);
      const worstG = roster.sort((a, b) => (a[1].form ?? 0) - (b[1].form ?? 0))[0];
      const freeNow = Object.entries(war.cracks).filter(([, c]) => !c.pimp && c.closes >= 2)
        .sort((a, b) => (b[1].form ?? 0) - (a[1].form ?? 0))[0];
      if (worstG && freeNow && (freeNow[1].form ?? 0) - (worstG[1].form ?? 0) > 0.5) {
        cp.roster = (cp.roster || []).filter((g) => g !== worstG[0]);
        cp.roster.push(freeNow[0]);
        freeNow[1].pimp = cname;
        worstG[1].pimp = null;
        war.lastTradeDown = Date.now();
        lines.push(`👑➡️ TRADE-DOWN — ${cname} cut ${worstG[0]} loose (form ${(worstG[1].form ?? 0).toFixed(2)}) and took ${freeNow[0]} off the street (form ${(freeNow[1].form ?? 0).toFixed(2)}) — kingpins upgrade, deadweight walks`);
      }
    }
  }

  for (const l of lines) { say(war, l); log(l); }
  return lines;
}
