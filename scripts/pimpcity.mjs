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
    war.cracks[c.name] = { w: { ...c.w }, tag: c.tag, pimp: null, net: 0, wins: 0, losses: 0, closes: 0, stolen: 0, gen: 0 };
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
          w.cracks[c.name] = { w: { ...c.w }, tag: c.tag, pimp: null, net: 0, wins: 0, losses: 0, closes: 0, stolen: 0, gen: 0 };
      }
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
      })).sort((a, b) => b.net - a.net),
      cracks: Object.entries(w.cracks).map(([name, c]) => ({
        name, tag: c.tag, pimp: c.pimp, net: +c.net.toFixed(4), wins: c.wins,
        losses: c.losses, closes: c.closes, stolen: c.stolen, gen: c.gen,
      })).sort((a, b) => b.net - a.net),
      retired: Object.entries(w.retired || {}).map(([name, c]) => ({
        name, tag: c.tag, pimp: c.pimp, net: +c.net.toFixed(4), wins: c.wins,
        losses: c.losses, closes: c.closes, stolen: c.stolen, gen: c.gen,
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
  let s = (w.score ?? 1) * (+c.score || 0) / 10;
  s += (w.chg ?? 0) * Math.min(8, Math.abs(+c.changePct || 0));
  s += (w.mom ?? 0) * (+c.changePct || 0);
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
        const sc = crackScore(crack, c) + (pname === topPimp ? 4 : 0) - (pname === botPimp ? 4 : 0);
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
      const sc = crackScore({ name: gname, ...crack }, c);
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
    // newest open intent on this symbol before the close
    let hit = null;
    for (let i = intents.length - 1; i >= 0; i--) {
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
    cr.net += net; cr.closes++;
    if (net >= 0) cr.wins++; else cr.losses++;
    if (pm) {
      pm.net += net;
      if (net >= 0) pm.wins++; else pm.losses++;
    }
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
  const crackRows = Object.entries(war.cracks).filter(([, c]) => c.closes >= 2);
  if (crackRows.length < 3) return lines;
  crackRows.sort((a, b) => b[1].net - a[1].net);
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
    const mutant = { w: {}, tag: 'spawn of ' + worstName, pimp: worst.pimp, net: 0, wins: 0, losses: 0, closes: 0, stolen: 0, gen: war.gen };
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

  for (const l of lines) { say(war, l); log(l); }
  return lines;
}
