// On-chain discovery scanner — finds high-volume/high-liquidity Solana (and
// other chain) tokens trading on DEXs, scores them, and emits a ranked
// candidate list to api/onchain-hot.json for the executor's onchain lane.
//
// Data: DexScreener public API (keyless) — live pair liquidity, 24h volume,
// pair age, tx counts. Optional rugcheck.xyz audit for top candidates
// (keyless). No credentials needed — this is pure market intelligence.
// Execution against the candidates requires Bitget Wallet OpenAPI creds
// (BGW_API_KEY/BGW_API_SECRET) or a funded bot keypair — see
// scripts/exchange/onchain.mjs.
//
// Operator intent: "trade high-volume/high-market-cap onchain coins" —
// this feed is the funnel. The execution lane stays gated on creds +
// audit results; discovery alone never authorizes a trade.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './load-env.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
const TF = () => AbortSignal.timeout(12000);

const writeJson = (file, obj) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
};

// ---- gates: what counts as a real candidate (not a scam wick) ----
const MIN_LIQ_USD = +(process.env.ONCHAIN_MIN_LIQ_USD || 50_000);
const MIN_VOL24_USD = +(process.env.ONCHAIN_MIN_VOL24_USD || 100_000);
const MIN_AGE_H = +(process.env.ONCHAIN_MIN_AGE_H || 2); // brand-new pairs = sniper farms
const MIN_TXNS_24H = +(process.env.ONCHAIN_MIN_TXNS || 100);
const RUGCHECK_TOP_N = +(process.env.ONCHAIN_AUDIT_TOP_N || 8);
const CHAINS = (process.env.ONCHAIN_CHAINS || 'solana,base,bsc').split(',').map((s) => s.trim());

// DexScreener discovery: keyword search PLUS the token-profiles/boosts feeds
// (paid promotions = active marketing = attention flows) — the boosts lists
// surface tokens keyword search can't find. Pair data resolves per token.
const SEARCH_TERMS = ['solana', 'pump', 'moon', 'based', 'meme', 'ai', 'cat', 'dog'];

const j = async (url) => {
  const res = await fetch(url, { signal: TF(), headers: { 'user-agent': 'sentinel/1.0' } });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
};

async function fetchCandidates() {
  const seen = new Map();
  const add = (p) => {
    if (!CHAINS.includes(p.chainId)) return;
    const key = `${p.chainId}:${p.pairAddress}`;
    const existing = seen.get(key);
    if (!existing || (p.volume?.h24 || 0) > (existing.volume?.h24 || 0)) seen.set(key, p);
  };
  await Promise.all([
    // keyword search — broad net
    ...SEARCH_TERMS.map(async (term) => {
      try {
        const d = await j(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`);
        for (const p of d.pairs || []) add(p);
      } catch {}
    }),
    // trending: latest profiles + top boosted tokens → resolve their pairs
    (async () => {
      try {
        const [profiles, boosts] = await Promise.all([
          j('https://api.dexscreener.com/token-profiles/latest/v1').catch(() => []),
          j('https://api.dexscreener.com/token-boosts/top/v1').catch(() => []),
        ]);
        const addrs = [...profiles, ...boosts]
          .filter((t) => CHAINS.includes(t.chainId))
          .map((t) => t.tokenAddress)
          .filter(Boolean);
        for (let i = 0; i < addrs.length; i += 30) {
          const chunk = addrs.slice(i, i + 30);
          try {
            const d = await j(
              `https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`
            );
            for (const p of d.pairs || []) add(p);
          } catch {}
        }
      } catch {}
    })(),
  ]);
  return [...seen.values()];
}

function score(p) {
  const liq = +(p.liquidity?.usd || 0);
  const vol = +(p.volume?.h24 || 0);
  const ageH = (Date.now() - (p.pairCreatedAt || 0)) / 36e5;
  const txns = (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0);
  const buys = p.txns?.h24?.buys || 0;
  const buyRatio = txns ? buys / txns : 0;
  const mcap = +(p.marketCap || p.fdv || 0);
  if (liq < MIN_LIQ_USD || vol < MIN_VOL24_USD || ageH < MIN_AGE_H || txns < MIN_TXNS_24H)
    return null;
  // turnover ratio: vol/liq = organic velocity; >100 is often wash/farm
  const turnover = vol / Math.max(1, liq);
  let s = 0;
  s += Math.min(30, Math.log10(Math.max(1, vol)) * 5); // volume weight
  s += Math.min(20, Math.log10(Math.max(1, liq)) * 4); // liquidity weight
  s += Math.min(15, Math.log10(Math.max(1, mcap)) * 2); // mcap weight
  s += Math.min(10, Math.log10(Math.max(1, txns)) * 3); // activity
  s += buyRatio > 0.55 ? 10 : buyRatio > 0.45 ? 5 : 0; // buy-side pressure
  if (turnover > 60) s -= 15; // wash-trading smell
  if (ageH < 12) s -= 8; // fresh-pair discount
  return Math.round(s);
}

async function auditTop(cands) {
  // rugcheck.xyz is solana-only and keyless — returns risk score + flags.
  const out = {};
  await Promise.all(
    cands.slice(0, RUGCHECK_TOP_N).map(async (c) => {
      if (c.chainId !== 'solana') return;
      try {
        const r = await j(
          `https://api.rugcheck.xyz/v1/tokens/${c.baseToken.address}/report/summary`
        );
        out[c.pairAddress] = {
          score: r.score ?? null,
          risks: (r.risks || []).map((x) => x.name).slice(0, 5),
          rugged: !!r.rugged,
        };
      } catch {}
    })
  );
  return out;
}

async function main() {
  const pairs = await fetchCandidates();
  const catalog = (() => {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(API, 'exec-catalog.json'), 'utf8'));
      const arr = Array.isArray(c) ? c : c.symbols || Object.keys(c);
      return new Set(arr.map((s) => String(s.symbol || s).toUpperCase()));
    } catch { return new Set(); }
  })();
  const byToken = new Map(); // one candidate per token contract — a token
  // with five pools shouldn't hold five slots
  for (const x of pairs.map((p) => ({ p, s: score(p) })).filter((x) => x.s != null).sort((a, b) => b.s - a.s)) {
    const k = `${x.p.chainId}:${x.p.baseToken?.address || x.p.pairAddress}`;
    if (!byToken.has(k)) byToken.set(k, x);
  }
  const ranked = [...byToken.values()].slice(0, 40);
  const audits = await auditTop(ranked.map((x) => x.p));
  const hot = ranked.map(({ p, s }) => {
    const base = (p.baseToken?.symbol || '').toUpperCase();
    const perpSym = `${base}USDT`;
    return {
      chain: p.chainId,
      symbol: base,
      contract: p.baseToken?.address,
      pair: p.pairAddress,
      dex: p.dexId,
      score: s,
      priceUsd: +(p.priceUsd || 0),
      liqUsd: Math.round(+(p.liquidity?.usd || 0)),
      vol24hUsd: Math.round(+(p.volume?.h24 || 0)),
      mcapUsd: Math.round(+(p.marketCap || p.fdv || 0)),
      ageH: Math.round(((Date.now() - (p.pairCreatedAt || 0)) / 36e5) * 10) / 10,
      txns24h: (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0),
      chg24h: +(p.priceChange?.h24 || 0),
      audit: audits[p.pairAddress] || null,
      // executable today via the perp lane if Bitget lists it — the exec
      // prefers the perp when both exist (leverage + exchange-side stops)
      perpAvailable: catalog.has(perpSym),
      perpSymbol: catalog.has(perpSym) ? perpSym : null,
    };
  });
  writeJson(path.join(API, 'onchain-hot.json'), {
    refreshedAt: new Date().toISOString(),
    ts: Date.now(),
    ttlMs: 15 * 60e3,
    chains: CHAINS,
    scanned: pairs.length,
    gates: { MIN_LIQ_USD, MIN_VOL24_USD, MIN_AGE_H, MIN_TXNS_24H },
    hot,
  });
  console.log(
    `onchain-scan: ${pairs.length} pairs scanned -> ${hot.length} candidates` +
      ` (${hot.filter((h) => h.perpAvailable).length} perp-backed, ${Object.keys(audits).length} audited)`
  );
}

main().catch((e) => console.warn(`onchain-scan failed, keeping last snapshot: ${e.message}`));
