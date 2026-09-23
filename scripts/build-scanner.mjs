// Builds api/market-scanner.json directly from Bitget public spot data.
// Universe: Bitget spot USDT pairs (excludes the RWA tokenized-stock zone and
// fiat/stable bases). Signals score real momentum (RSI on 1h klines, 24h
// change, volume surge, spread tightness). Never wipes a good snapshot —
// upstream failures keep the previous file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
const SYMBOLS_URL = 'https://api.bitget.com/api/v2/spot/public/symbols';
const TICKERS_URL = 'https://api.bitget.com/api/v2/spot/market/tickers';
const CANDLES_URL = 'https://api.bitget.com/api/v2/spot/market/candles';
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const MIN_QUOTE_VOLUME = 250_000; // USDT notional — liquid listings only
const KLINE_CANDIDATES = 48; // top-volume pairs get 1h momentum metrics
const MAX_SIGNALS = 12;
const PULSE_FILE = path.join(API, 'pulse-history.json');
const PULSE_MAX_POINTS = 144; // ~24h at a 10min cadence
const LEDGER_FILE = path.join(API, 'signal-ledger.json');
const LEDGER_MAX = 1_000_000_000;
const LEDGER_TTL_MS = 24 * 3600 * 1000;
const REENTRY_COOLDOWN_MS = 2 * 3600 * 1000;
const UNTRACKED_TTL_MS = 3600 * 1000; // asset out of universe -> expire after 1h
const VAULT_FILE = path.join(API, 'vault.json');
const VAULT_PCT = 0.2; // share of realized gains swept into the hold basket
const TRADE_NOTIONAL = 1000; // dry-run $ per signal
const VAULT_ASSETS = ['BTC', 'ETH', 'SOL'];

const pct = (x) => Math.round(x * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const STABLE_FIAT = new Set([
  'USDC', 'USDT', 'USD1', 'USDE', 'USDD', 'DAI', 'FDUSD', 'TUSD', 'PYUSD',
  'RLUSD', 'USDP', 'GUSD', 'USDY', 'USTB', 'BFUSD', 'AUSD', 'EUR', 'EURC',
  'GBP', 'BRL', 'TRY', 'AUD', 'USDG', 'CUSD', 'XUSD', 'USDS', 'SUSDE',
]);

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

async function fetchKlines(symbol) {
  const res = await fetch(
    `${CANDLES_URL}?symbol=${symbol}&granularity=1h&limit=48`
  );
  if (!res.ok) return null;
  const { data } = await res.json();
  if (!Array.isArray(data) || data.length < 20) return null;
  const rows = data
    .map((c) => ({ ts: Number(c[0]), close: Number(c[4]), qv: Number(c[6]) }))
    .sort((a, b) => a.ts - b.ts); // oldest first
  const closes = rows.map((r) => r.close);
  const last6 = rows.slice(-6).reduce((a, r) => a + r.qv, 0) / 6;
  const prior = rows.slice(0, -6);
  const priorAvg = prior.reduce((a, r) => a + r.qv, 0) / (prior.length || 1);
  return {
    rsi14: rsi(closes),
    volRatio: priorAvg > 0 ? last6 / priorAvg : 1,
    closes,
  };
}

async function main() {
  const [symbolsRes, tickersRes] = await Promise.all([
    fetch(SYMBOLS_URL),
    fetch(TICKERS_URL),
  ]);
  if (!symbolsRes.ok || !tickersRes.ok)
    throw new Error(`bitget http ${symbolsRes.status}/${tickersRes.status}`);
  const { data: symbols } = await symbolsRes.json();
  const { data: tickers } = await tickersRes.json();

  const online = symbols.filter(
    (s) => s.status === 'online' && s.areaSymbol !== 'yes'
  );
  const listed = new Set(online.map((s) => (s.baseCoin ?? '').toUpperCase()));
  fs.writeFileSync(
    path.join(API, 'bitget-symbols.json'),
    JSON.stringify([...listed].sort())
  );
  const usdtPairs = new Set(
    online
      .filter(
        (s) =>
          s.quoteCoin === 'USDT' &&
          !STABLE_FIAT.has((s.baseCoin ?? '').toUpperCase())
      )
      .map((s) => s.symbol.toUpperCase())
  );

  const rows = tickers
    .filter((t) => usdtPairs.has(t.symbol.toUpperCase()))
    .map((t) => {
      const last = Number(t.lastPr);
      const high = Number(t.high24h);
      const low = Number(t.low24h);
      const bid = Number(t.bidPr);
      const ask = Number(t.askPr);
      return {
        asset: t.symbol.replace(/USDT$/i, ''),
        symbol: `${t.symbol.replace(/USDT$/i, '')}USD`,
        pair: t.symbol,
        lastPrice: last,
        changePct: Number(t.changeUtc24h) * 100,
        quoteVolume: Number(t.quoteVolume),
        highPrice: high,
        lowPrice: low,
        rangePct: low > 0 ? ((high - low) / low) * 100 : 0,
        spreadPct: last > 0 && bid > 0 && ask > 0 ? ((ask - bid) / last) * 100 : 0,
        rangePosition: high > low ? (last - low) / (high - low) : 0.5,
      };
    })
    .filter(
      (r) =>
        Number.isFinite(r.lastPrice) &&
        r.lastPrice > 0 &&
        r.quoteVolume >= MIN_QUOTE_VOLUME
    )
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  // hourly klines for the top-volume candidates -> real momentum metrics
  const enriched = new Map();
  const candidates = rows.slice(0, KLINE_CANDIDATES);
  for (let i = 0; i < candidates.length; i += 12) {
    const batch = candidates.slice(i, i + 12);
    await Promise.all(
      batch.map(async (r) => {
        const k = await fetchKlines(r.pair).catch(() => null);
        if (k) enriched.set(r.asset, k);
      })
    );
  }
  // one retry pass for rate-limited/missed klines
  const missing = candidates.filter((r) => !enriched.has(r.asset));
  if (missing.length) {
    await new Promise((r) => setTimeout(r, 1500));
    await Promise.all(
      missing.map(async (r) => {
        const k = await fetchKlines(r.pair).catch(() => null);
        if (k) enriched.set(r.asset, k);
      })
    );
  }

  const rank = (arr, v) => arr.filter((x) => x <= v).length / arr.length;
  const chgs = rows.map((r) => r.changePct).sort((a, b) => a - b);
  const vols = rows.map((r) => r.quoteVolume).sort((a, b) => a - b);
  const spreads = rows.map((r) => r.spreadPct).sort((a, b) => a - b);
  const surges = [...enriched.values()].map((k) => k.volRatio).sort((a, b) => a - b);

  const strategyFor = (r, k) => {
    if (r.changePct > 3 && r.rangePosition > 0.75) return 'Breakout Continuation';
    if (k && k.volRatio > 1.8 && r.changePct > 0) return 'Volume Surge';
    if (r.changePct < -3) return 'Momentum Breakdown';
    if (k && k.rsi14 < 35) return 'Oversold Reversal';
    return 'Momentum Confluence';
  };

  // signals need momentum metrics; pairs whose kline fetch failed get a
  // neutral profile instead of being dropped from the board entirely
  const neutral = { rsi14: 50, volRatio: 1, closes: null };
  const ranked = rows
    .slice(0, KLINE_CANDIDATES)
    .map((r) => {
      const k = enriched.get(r.asset) ?? neutral;
      const momentumRank = rank(chgs, r.changePct);
      const rsiTilt = clamp((k.rsi14 - 30) / 40, 0, 1); // 30→0, 70→1
      const momentumScore = Math.round(momentumRank * 60 + rsiTilt * 40);
      const volumeScore = Math.round(rank(vols, r.quoteVolume) * 100);
      const liquidityScore = Math.round((1 - rank(spreads, r.spreadPct)) * 100);
      const surgeScore = Math.round(rank(surges, k.volRatio) * 100);
      const score = Math.round(
        momentumScore * 0.4 + volumeScore * 0.25 + liquidityScore * 0.2 + surgeScore * 0.15
      );
      return { ...r, k, momentumScore, volumeScore, liquidityScore, surgeScore, score };
    })
    .sort((a, b) => b.score - a.score);
  const signals = ranked
    .slice(0, MAX_SIGNALS)
    .map((r) => {
      const direction = r.changePct >= 0 ? 'LONG' : 'SHORT';
      const strategy = strategyFor(r, r.k);
      const targetPct = pct(clamp(r.rangePct * 0.35, 3, 15));
      const hasK = enriched.has(r.asset);
      const drivers = [
        `24h momentum ${r.changePct >= 0 ? '+' : ''}${pct(r.changePct)}%`,
        hasK
          ? `RSI(1h) ${Math.round(r.k.rsi14)} · volume ${round(r.k.volRatio, 1)}× baseline`
          : `Quote volume $${(r.quoteVolume / 1e6).toFixed(1)}M`,
        `Range position ${Math.round(r.rangePosition * 100)}% · spread ${pct(r.spreadPct)}%`,
      ];
      return {
        asset: r.asset,
        grade: r.score >= 85 ? 'A' : r.score >= 75 ? 'BBB' : r.score >= 65 ? 'BB' : 'B',
        score: r.score,
        social: null,
        symbol: r.symbol,
        thesis: `${strategy} on ${r.asset} | Confluence ${r.score}/100 | ${drivers[0]} | ${drivers[1]}`,
        assetId: r.asset.toLowerCase(),
        drivers,
        riskPct: pct(clamp(r.spreadPct * 2 + Math.abs(r.changePct) * 0.08, 0.3, 8)),
        summary: hasK
          ? `${strategy}: ${direction === 'LONG' ? 'upside' : 'downside'} momentum, RSI(1h) ${Math.round(r.k.rsi14)}, volume ${round(r.k.volRatio, 1)}× baseline.`
          : `${strategy}: ${direction === 'LONG' ? 'upside' : 'downside'} momentum on $${(r.quoteVolume / 1e6).toFixed(0)}M quote volume.`,
        harmonic: null,
        lowPrice: r.lowPrice,
        rangePct: pct(r.rangePct),
        strategy,
        changePct: pct(r.changePct),
        direction,
        highPrice: r.highPrice,
        lastPrice: r.lastPrice,
        spreadPct: pct(r.spreadPct),
        targetPct,
        updatedAt: new Date().toISOString(),
        entryPrice: r.lastPrice,
        quoteVolume: Math.round(r.quoteVolume),
        socialScore: 0,
        targetPrice:
          direction === 'LONG'
            ? r.lastPrice * (1 + targetPct / 100)
            : r.lastPrice * (1 - targetPct / 100),
        signalFamily: 'momentum',
        momentumScore: r.momentumScore,
        rangePosition: round(r.rangePosition),
        reversalScore: r.surgeScore,
        liquidityScore: r.liquidityScore,
      };
    });

  const movers = rows
    .slice()
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 6)
    .map((r) => ({ price: r.lastPrice, symbol: r.asset, changePct: pct(r.changePct) }));
  const laggards = rows
    .slice()
    .sort((a, b) => a.changePct - b.changePct)
    .slice(0, 6)
    .map((r) => ({ price: r.lastPrice, symbol: r.asset, changePct: pct(r.changePct) }));

  const advancing = rows.filter((r) => r.changePct > 0).length;
  const declining = rows.filter((r) => r.changePct < 0).length;
  const sorted = rows.map((r) => r.changePct).sort((a, b) => a - b);
  const medianChangePct = sorted.length ? pct(sorted[Math.floor(sorted.length / 2)]) : 0;
  const breadthPct = rows.length ? pct((advancing / rows.length) * 100) : 0;

  let history = [];
  try {
    history = JSON.parse(fs.readFileSync(PULSE_FILE, 'utf8'));
  } catch {}
  history.push({ ts: Date.now(), value: pct(100 + medianChangePct) });
  history = history.slice(-PULSE_MAX_POINTS);
  fs.writeFileSync(PULSE_FILE, JSON.stringify(history));
  const values = history.map((p) => p.value);

  let fx = { audPerUsd: 1.5, usdPerAud: 0.667 };
  try {
    const fxJson = await (await fetch(FX_URL)).json();
    const aud = fxJson?.rates?.AUD;
    if (aud) fx = { audPerUsd: aud, usdPerAud: round(1 / aud, 4) };
  } catch {}

  // ---- signal pressure: near-miss candidates + what's blocking them ----
  const FACTORS = [
    ['momentumScore', 'momentum'],
    ['volumeScore', 'quote volume'],
    ['liquidityScore', 'liquidity'],
    ['surgeScore', 'vol surge'],
  ];
  const cutoff = ranked[MAX_SIGNALS - 1]?.score ?? 0;
  const pressureList = ranked
    .slice(MAX_SIGNALS, MAX_SIGNALS + 10)
    .map((r) => ({
      asset: r.asset,
      score: r.score,
      gap: Math.max(0, cutoff - r.score),
      lean: r.changePct >= 0 ? 'LONG' : 'SHORT',
      blocker: FACTORS.reduce((a, b) => (r[b[0]] < r[a[0]] ? b : a))[1],
    }));
  const pressurePct = cutoff
    ? Math.round(
        (pressureList.reduce((a, c) => a + c.score, 0) /
          (pressureList.length || 1) /
          cutoff) *
          100
      )
    : 0;

  const snap = {
    fx,
    pressure: {
      pct: Math.min(pressurePct, 99),
      cutoff,
      candidates: pressureList,
      scanning: ranked.length,
    },
    pulse: {
      low: Math.min(...values),
      high: Math.max(...values),
      delta: pct((values.at(-1) ?? 100) - (values[0] ?? 100)),
      series: history,
      baseline: 100,
    },
    movers,
    status: 'live',
    signals,
    laggards,
    overview: {
      advancing,
      declining,
      breadthPct,
      longSignals: signals.filter((s) => s.direction === 'LONG').length,
      totalVolume: Math.round(rows.reduce((a, r) => a + r.quoteVolume, 0)),
      harmonicHits: 0,
      scannedPairs: rows.length,
      shortSignals: signals.filter((s) => s.direction === 'SHORT').length,
      socialCoverage: 0,
      medianChangePct,
      averageSpreadPct: pct(rows.reduce((a, r) => a + r.spreadPct, 0) / (rows.length || 1)),
    },
    refreshedAt: new Date().toISOString(),
    scanWindowSeconds: 600,
    error: null,
    source: 'bitget-direct',
    universeFilter: 'bitget-spot',
  };

  fs.writeFileSync(path.join(API, 'market-scanner.json'), JSON.stringify(snap));

  // ---- coin detail: sparklines + metrics for every kline-enriched pair ----
  const priceByAsset = new Map(rows.map((r) => [r.asset, r.lastPrice]));
  const coinDetail = {};
  for (const r of rows.slice(0, KLINE_CANDIDATES)) {
    const k = enriched.get(r.asset);
    if (!k) continue;
    coinDetail[r.asset] = {
      price: r.lastPrice,
      changePct: pct(r.changePct),
      quoteVolume: Math.round(r.quoteVolume),
      rsi14: Math.round(k.rsi14),
      volRatio: round(k.volRatio, 2),
      spark: k.closes,
    };
  }
  fs.writeFileSync(
    path.join(API, 'coin-detail.json'),
    JSON.stringify({ refreshedAt: snap.refreshedAt, coins: coinDetail })
  );

  // headline prices for the landing header chips
  const majors = {};
  for (const sym of ['BTC', 'ETH', 'SOL']) {
    const r = rows.find((x) => x.asset === sym);
    if (r) majors[sym] = { price: r.lastPrice, changePct: pct(r.changePct) };
  }
  fs.writeFileSync(
    path.join(API, 'prices.json'),
    JSON.stringify({ refreshedAt: snap.refreshedAt, majors })
  );

  // ---- signal ledger: open entries + settled outcomes ----
  let ledger = { entries: [], stats: {} };
  let ledgerCorrupt = false;
  try {
    ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'));
  } catch (err) {
    ledgerCorrupt = err.code !== 'ENOENT'; // file exists but won't parse
  }
  ledger.entries ??= [];
  const now = Date.now();
  const openFor = (a, d) =>
    ledger.entries.some(
      (e) => e.asset === a && e.direction === d && e.status === 'open'
    );
  const recentClosed = (a, d) =>
    ledger.entries.some(
      (e) =>
        e.asset === a &&
        e.direction === d &&
        e.status !== 'open' &&
        now - (e.exitTs ?? 0) < REENTRY_COOLDOWN_MS
    );
  for (const s of signals) {
    if (!openFor(s.asset, s.direction) && !recentClosed(s.asset, s.direction)) {
      ledger.entries.unshift({
        asset: s.asset,
        direction: s.direction,
        entry: s.entryPrice,
        targetPct: s.targetPct,
        targetPrice: s.targetPrice,
        score: s.score,
        grade: s.grade,
        strategy: s.strategy,
        ts: now,
        status: 'open',
        exitPrice: null,
        exitTs: null,
        pnlPct: null,
      });
    }
  }
  const freshDir = new Map(signals.map((s) => [s.asset, s.direction]));
  for (const e of ledger.entries) {
    if (e.status !== 'open') continue;
    const px = priceByAsset.get(e.asset);
    const age = now - e.ts;
    let pnl = e.pnlPct;
    if (px) {
      pnl = pct(
        e.direction === 'LONG'
          ? ((px - e.entry) / e.entry) * 100
          : ((e.entry - px) / e.entry) * 100
      );
      e.lastPrice = px;
      e.peakPnl = Math.max(e.peakPnl ?? -Infinity, pnl);
      // lock 50%: once price covers half the target, bank half the
      // position and move the stop on the remainder to breakeven
      if (e.lockPnl == null && pnl >= e.targetPct / 2) {
        e.lockPnl = pnl;
        e.lockedAt = now;
        e.beStop = true;
      }
    }
    const settle = (status, exitPx, rawPnl) => {
      e.status = status;
      e.exitPrice = exitPx;
      e.exitTs = now;
      e.pnlPct =
        e.lockPnl != null ? pct((e.lockPnl + rawPnl) / 2) : pct(rawPnl);
    };
    const hit =
      px &&
      (e.direction === 'LONG' ? px >= e.targetPrice : px <= e.targetPrice);
    const beStopped = px && e.beStop && pnl <= 0;
    const stopped = px && pnl <= -Math.max(4, e.targetPct);
    const reversed =
      px && freshDir.get(e.asset) && freshDir.get(e.asset) !== e.direction;
    const expired = age > LEDGER_TTL_MS || (!px && age > UNTRACKED_TTL_MS);
    if (hit) settle('won', px, pnl);
    else if (beStopped) settle('breakeven', e.entry, 0);
    else if (stopped) settle('stopped', px, pnl);
    else if (reversed) settle('reversed', px, pnl);
    else if (expired) settle('expired', px ?? e.lastPrice ?? e.entry, px ? pnl : e.pnlPct ?? 0);
    else e.pnlPct = pnl; // live mark on open entries
  }
  ledger.entries = ledger.entries.slice(0, LEDGER_MAX);
  const closed = ledger.entries.filter((e) => e.status !== 'open');
  const wins = closed.filter((e) => e.status === 'won').length;
  const losses = closed.filter(
    (e) => e.status === 'stopped' || e.status === 'reversed'
  ).length;
  ledger.stats = {
    open: ledger.entries.filter((e) => e.status === 'open').length,
    closed: closed.length,
    wins,
    losses,
    flat: closed.length - wins - losses, // breakeven + expired
    winRate: wins + losses >= 5 ? pct((wins / (wins + losses)) * 100) : null,
    avgPnlPct: closed.length
      ? pct(closed.reduce((a, e) => a + (e.pnlPct ?? 0), 0) / closed.length)
      : null,
  };
  const by = (key) => {
    const g = {};
    for (const e of closed) {
      const k = e[key] ?? 'other';
      (g[k] ??= { n: 0, wins: 0, pnl: 0 }).n++;
      g[k].wins += e.status === 'won' ? 1 : 0;
      g[k].pnl += e.pnlPct ?? 0;
    }
    return Object.fromEntries(
      Object.entries(g).map(([k, v]) => [
        k,
        { n: v.n, winRate: pct((v.wins / v.n) * 100), avgPnlPct: pct(v.pnl / v.n) },
      ])
    );
  };
  ledger.stats.byDirection = by('direction');
  ledger.stats.byStrategy = by('strategy');
  const sortedClosed = [...closed].sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0));
  ledger.stats.best = sortedClosed.at(-1)?.asset ?? null;
  ledger.stats.worst = sortedClosed[0]?.asset ?? null;
  if (!ledgerCorrupt) fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger));

  // ---- vault: a fixed share of every realized gain compounds into a
  // hold-forever BTC/ETH/SOL basket, marked to live prices ----
  let vault = { depositedUsd: 0, holdings: {}, fills: [] };
  let vaultCorrupt = false;
  try {
    vault = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  } catch (err) {
    vaultCorrupt = err.code !== 'ENOENT';
  }
  vault.fills ??= [];
  vault.holdings ??= {};
  for (const e of closed) {
    if (e.vaulted || (e.pnlPct ?? 0) <= 0) continue;
    const usd = TRADE_NOTIONAL * (e.pnlPct / 100) * VAULT_PCT;
    vault.depositedUsd = pct(vault.depositedUsd + usd);
    vault.fills.unshift({
      ts: e.exitTs ?? now,
      asset: e.asset,
      status: e.status,
      pnlPct: e.pnlPct,
      usd: round(usd, 2),
    });
    for (const sym of VAULT_ASSETS) {
      const p = priceByAsset.get(sym);
      if (!p) continue;
      const h = (vault.holdings[sym] ??= { units: 0, costUsd: 0 });
      h.units += usd / VAULT_ASSETS.length / p;
      h.costUsd = round(h.costUsd + usd / VAULT_ASSETS.length, 2);
    }
    e.vaulted = true;
    if (!ledgerCorrupt) fs.writeFileSync(LEDGER_FILE, JSON.stringify(ledger));
  }
  let valueUsd = 0;
  const holdings = {};
  for (const [sym, h] of Object.entries(vault.holdings)) {
    const p = priceByAsset.get(sym);
    const v = h.units * (p ?? 0);
    valueUsd += v;
    holdings[sym] = {
      units: round(h.units, 6),
      costUsd: h.costUsd,
      valueUsd: round(v, 2),
      price: p ?? null,
    };
  }
  if (!vaultCorrupt) {
    fs.writeFileSync(
      VAULT_FILE,
      JSON.stringify({
        refreshedAt: snap.refreshedAt,
        vaultPct: VAULT_PCT,
        notional: TRADE_NOTIONAL,
        depositedUsd: vault.depositedUsd,
        valueUsd: round(valueUsd, 2),
        pnlUsd: round(valueUsd - vault.depositedUsd, 2),
        fills: vault.fills.slice(0, 200),
        holdings,
      })
    );
  }

  // pipeline health for the landing footer
  let health = {};
  try {
    health = JSON.parse(fs.readFileSync(path.join(API, 'health.json'), 'utf8'));
  } catch {}
  health.scanner = {
    ok: true,
    at: snap.refreshedAt,
    pairs: rows.length,
    signals: signals.length,
    klineEnriched: enriched.size,
    ledgerOpen: ledger.stats.open,
  };
  fs.writeFileSync(path.join(API, 'health.json'), JSON.stringify(health));

  console.log(
    `scanner: ${signals.length} signals / ${movers.length} movers / ${laggards.length} laggards / ${rows.length} pairs (${enriched.size} kline-enriched) | ledger ${ledger.stats.open} open, ${wins}/${closed.length} won`
  );
}

main().catch((e) => {
  console.warn(`scanner build failed, keeping last snapshot: ${e.message}`);
});
