// Position episodes use each book's side convention, never the active venue's.
const round = (x, n = 4) => +x.toFixed(n);

export function fifoEpisodes(fills, { positionSide = false, positionMode = 'oneway' } = {}) {
  const current = new Map(), out = [];
  for (const f of [...fills].sort((a, b) => a.ts - b.ts)) {
    const size = +f.size || 0;
    if (!(size > 0) || !f.symbol) continue;
    const close = f.tradeSide === 'close' || (!f.tradeSide && +f.profit !== 0);
    const buy = f.side === 'buy';
    const long = close && !positionSide && positionMode !== 'hedge' ? !buy : buy;
    const dir = long ? 'long' : 'short';
    const key = `${f.symbol}:${dir}`;
    let e = current.get(key);
    if (!e && close) {
      out.push({ symbol: f.symbol, dir, openTs: null, closeTs: f.ts,
        fills: 1, fees: +f.fee || 0, profit: +f.profit || 0,
        netUsd: (+f.profit || 0) - (+f.fee || 0), notional: 0,
        unmatched: true, bot: f.src === 'api', riskUsd: 0 });
      continue;
    }
    if (!e) {
      e = { symbol: f.symbol, dir, openTs: f.ts, fills: 0, fees: 0,
        profit: 0, notional: 0, riskUsd: 0, remaining: 0, openedQty: 0,
        bot: f.src == null ? null : f.src === 'api', strat: null };
      current.set(key, e);
    }
    e.fills++;
    e.fees += +f.fee || 0;
    e.riskUsd = Math.max(e.riskUsd, +f.riskUsd || 0);
    if (!close) {
      e.remaining += size;
      e.openedQty += size;
      e.notional += +f.notionalUsd || size * (+f.price || 0);
      if (f.src && f.src !== 'api') e.bot = false;
    } else {
      if (size > e.remaining + Math.max(1e-9, e.openedQty * 1e-8)) e.unmatched = true;
      e.remaining -= size;
      e.profit += +f.profit || 0;
      if (e.remaining <= Math.max(1e-9, e.openedQty * 1e-8)) {
        e.closeTs = f.ts;
        e.netUsd = e.profit - e.fees;
        out.push(e);
        current.delete(key);
      }
    }
  }
  for (const e of current.values()) out.push({ ...e, open: true, netUsd: e.profit - e.fees });
  return out;
}

export function episodeStats(episodes) {
  const closed = episodes.filter((e) => !e.open && !e.unmatched);
  const wins = closed.filter((e) => e.netUsd > 0);
  const losses = closed.filter((e) => e.netUsd <= 0);
  const gain = wins.reduce((a, e) => a + e.netUsd, 0);
  const loss = -losses.reduce((a, e) => a + e.netUsd, 0);
  const rs = closed.filter((e) => e.riskUsd > 0).map((e) => e.netUsd / e.riskUsd);
  const mean = rs.length ? rs.reduce((a, x) => a + x, 0) / rs.length : 0;
  const sd = rs.length > 1 ? Math.sqrt(rs.reduce((a, x) => a + (x - mean) ** 2, 0) / (rs.length - 1)) : 0;
  return {
    episodes: closed.length, open: episodes.filter((e) => e.open).length,
    unmatchedCloses: episodes.filter((e) => e.unmatched).length,
    botEpisodes: closed.filter((e) => e.bot === true).length,
    wins: wins.length, winRatePct: closed.length ? round(100 * wins.length / closed.length, 1) : null,
    netUsd: round(closed.reduce((a, e) => a + e.netUsd, 0)),
    feesUsd: round(closed.reduce((a, e) => a + e.fees, 0)),
    profitFactor: loss > 0 ? round(gain / loss, 2) : null,
    sqn: rs.length >= 30 && sd > 1e-9 * Math.max(1, Math.abs(mean)) ? round(mean / sd * Math.sqrt(Math.min(rs.length, 100)), 2) : null, /* sqn-guard */
    sqnN: rs.length, meanR: rs.length ? round(mean, 3) : null,
    firstTs: episodes.length ? Math.min(...episodes.map((e) => e.openTs || e.closeTs)) : null,
    lastTs: episodes.length ? Math.max(...episodes.map((e) => e.closeTs || e.openTs)) : null,
  };
}

export function familyStats(episodes) {
  const groups = {};
  for (const e of episodes) {
    if (e.open || e.unmatched) continue;
    (groups[e.strat || 'unattributed'] ||= []).push(e);
  }
  return Object.fromEntries(Object.entries(groups).map(([name, rows]) => {
    const returns = rows.filter((e) => e.notional > 0).map((e) => 100 * e.netUsd / e.notional);
    const stats = episodeStats(rows);
    return [name, { n: rows.length, winShare: stats.wins / rows.length,
      meanRetPct: returns.length ? round(returns.reduce((a, x) => a + x, 0) / returns.length, 4) : null,
      netUsd: stats.netUsd, feesUsd: stats.feesUsd, src: 'fills' }];
  }));
}
