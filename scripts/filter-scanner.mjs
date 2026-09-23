// Filters api/market-scanner.json down to coins listed on Bitget spot.
// Runs in the refresh workflow after pulling upstream snapshots.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
const BITGET_SYMBOLS_URL = 'https://api.bitget.com/api/v2/spot/public/symbols';

const res = await fetch(BITGET_SYMBOLS_URL);
if (!res.ok) throw new Error(`bitget symbols http ${res.status}`);
const { data } = await res.json();
const listed = new Set(
  (data ?? [])
    .filter((s) => s.status === 'online')
    .map((s) => (s.baseCoin ?? '').toUpperCase())
);
fs.writeFileSync(
  path.join(API, 'bitget-symbols.json'),
  JSON.stringify([...listed].sort())
);

const file = path.join(API, 'market-scanner.json');
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
const keep = (sym) => listed.has(String(sym ?? '').toUpperCase());

const signals = (snap.signals ?? []).filter((s) => keep(s.asset));
const movers = (snap.movers ?? []).filter((m) => keep(m.symbol));
const laggards = (snap.laggards ?? []).filter((l) => keep(l.symbol));

snap.signals = signals;
snap.movers = movers;
snap.laggards = laggards;
snap.overview = {
  ...snap.overview,
  longSignals: signals.filter((s) => s.direction === 'LONG').length,
  shortSignals: signals.filter((s) => s.direction === 'SHORT').length,
};
snap.universeFilter = 'bitget-spot';
snap.filteredAt = new Date().toISOString();

fs.writeFileSync(file, JSON.stringify(snap));
console.log(
  `bitget filter: kept ${signals.length} signals, ${movers.length} movers, ${laggards.length} laggards (${listed.size} listed coins)`
);
