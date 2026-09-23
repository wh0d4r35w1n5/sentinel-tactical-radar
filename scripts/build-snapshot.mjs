// Builds api/market-snapshot.json natively: live Jupiter quotes (SOL/USDC
// spot + strategy size), Solana RPC slot, and Bitget SOLUSDT 24h stats.
// Keeps the previous snapshot on failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
const FILE = path.join(API, 'market-snapshot.json');
const JUP = 'https://lite-api.jup.ag/swap/v1/quote';
const RPC = 'https://solana-rpc.publicnode.com';
const TICKERS = 'https://api.bitget.com/api/v2/spot/market/tickers';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const STRATEGY_LAMPORTS = 500_000; // 0.0005 SOL

const timed = async (fn) => {
  const t0 = Date.now();
  const v = await fn();
  return { v, ms: Date.now() - t0 };
};

async function jupQuote(amountLamports) {
  const q = new URLSearchParams({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amount: String(amountLamports),
    slippageBps: '100',
  });
  const { v: res, ms } = await timed(() => fetch(`${JUP}?${q}`));
  if (!res.ok) throw new Error(`jup quote http ${res.status}`);
  const data = await res.json();
  return { data, ms };
}

async function solanaSlot() {
  const { v: res, ms } = await timed(() =>
    fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }),
    })
  );
  if (!res.ok) throw new Error(`rpc http ${res.status}`);
  const j = await res.json();
  return { slot: j.result, latencyMs: ms };
}

async function solTicker() {
  const res = await fetch(`${TICKERS}?symbol=SOLUSDT`);
  if (!res.ok) return null;
  const { data } = await res.json();
  return Array.isArray(data) ? data[0] : null;
}

async function main() {
  const prev = JSON.parse(fs.readFileSync(FILE, 'utf8'));

  const [slotInfo, spotQ, stratQ, tick] = await Promise.all([
    solanaSlot(),
    jupQuote(1_000_000_000), // 1 SOL
    jupQuote(STRATEGY_LAMPORTS),
    solTicker(),
  ]);

  const spot = spotQ.data;
  const strat = stratQ.data;
  const solUsd = spot?.outAmount ? Number(spot.outAmount) / 1e6 : null;
  const change24h = tick ? Number(tick.changeUtc24h) * 100 : null;
  const routeLabel = (q) => q?.routePlan?.[0]?.swapInfo?.label ?? 'Jupiter Aggregator';

  const snap = {
    status: 'live',
    refreshedAt: new Date().toISOString(),
    pollSeconds: 60,
    pair: prev.pair ?? {
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      inputSymbol: 'SOL',
      outputSymbol: 'USDC',
      amountSol: 0.0005,
      slippageBps: 100,
    },
    rpc: { slot: slotInfo.slot, latencyMs: slotInfo.latencyMs },
    assets: {
      input: {
        mint: SOL_MINT,
        symbol: 'SOL',
        usdPrice: solUsd,
        priceChange24h: change24h,
        liquidity: tick ? Number(tick.quoteVolume) : null,
        decimals: 9,
      },
      output: {
        mint: USDC_MINT,
        symbol: 'USDC',
        usdPrice: 1,
        priceChange24h: 0,
        liquidity: null,
        decimals: 6,
      },
    },
    spot: {
      inputAmount: 1,
      outAmountRaw: spot.outAmount,
      outAmount: Number(spot.outAmount) / 1e6,
      routeLabel: routeLabel(spot),
      contextSlot: spot.contextSlot ?? slotInfo.slot,
      priceImpactPct: Number(spot.priceImpactPct ?? 0),
      swapUsdValue: solUsd,
      timeTakenMs: spotQ.ms,
    },
    strategy: {
      inputAmount: 0.0005,
      outAmountRaw: strat.outAmount,
      outAmount: Number(strat.outAmount) / 1e6,
      routeLabel: routeLabel(strat),
      contextSlot: strat.contextSlot ?? slotInfo.slot,
      priceImpactPct: Number(strat.priceImpactPct ?? 0),
      swapUsdValue: Number(strat.outAmount) / 1e6,
      timeTakenMs: stratQ.ms,
    },
  };

  fs.writeFileSync(FILE, JSON.stringify(snap));

  let health = {};
  try {
    health = JSON.parse(
      fs.readFileSync(path.join(API, 'health.json'), 'utf8')
    );
  } catch {}
  health.snapshot = {
    ok: true,
    at: snap.refreshedAt,
    slot: snap.rpc.slot,
    rpcLatencyMs: snap.rpc.latencyMs,
    route: snap.spot.routeLabel,
  };
  fs.writeFileSync(path.join(API, 'health.json'), JSON.stringify(health));

  console.log(
    `snapshot: slot ${snap.rpc.slot} (${snap.rpc.latencyMs}ms), SOL $${solUsd}, route ${snap.spot.routeLabel}`
  );
}

main().catch((e) => {
  console.warn(`snapshot build failed, keeping last file: ${e.message}`);
});
