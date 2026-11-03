// vault epoch restart — operator order: start carry from current NAV,
// kill the $64.63 stale high-water mark, clear the dd-100% kill-switch,
// and align the pimp-city vault KPI epoch. Run on the VPS:
//   sudo /opt/sentinel/.venv/bin/node? no — plain node, state dir.
// Everything auditable: the old vault epoch is archived INSIDE the file.
import fs from 'node:fs';
import { integrityNote } from './crc32.mjs';

const S = 'state';
const load = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (p, o) => {
  const body = JSON.stringify(o);
  fs.writeFileSync(p + '.tmp', body);
  fs.renameSync(p + '.tmp', p);
  integrityNote(p, body); // keep the checksum manifest honest
};

// ---- 1. wealth vault: archive epoch 1, restart armed at current NAV ----
const vPath = `${S}/wealth-vault.json`;
const v = load(vPath);
const equityUsd = 0; // live account reads $0 — navNow = equity + balance - lost
const navNow = equityUsd + (+v.balanceUsd || 0) - (+v.lostUsd || 0);
v.archive = [
  ...(v.archive || []),
  {
    at: new Date().toISOString(),
    reason: 'operator restart — carry starts from current NAV, not the dead $64.63 mark',
    balanceUsd: v.balanceUsd, lostUsd: v.lostUsd, transferredUsd: v.transferredUsd,
    hwmUsd: v.hwmUsd, sweeps: v.sweeps, sweptIdCount: Object.keys(v.sweptIds || {}).length,
  },
];
v.balanceUsd = 0;
v.transferredUsd = 0;
v.lostUsd = 0;
v.deployedUsd = 0;
v.sweeps = [];
v.hwmUsd = +navNow.toFixed(4); // carry gates on new highs from TODAY, not 64.63
// sweptIds KEPT — old fills can never re-sweep as fresh carry
v.updatedAt = new Date().toISOString();
write(vPath, v);
console.log(`vault: epoch archived (was $${9.5566} bal / $${v.archive.at(-1).lostUsd} lost / hwm $${v.archive.at(-1).hwmUsd}) → armed at hwm $${v.hwmUsd}`);

// ---- 2. equity peak: reset the dd tape — new epoch starts flat ----
const pPath = `${S}/equity-peak-live.json`;
fs.copyFileSync(pPath, pPath + '.bak-vaultreset');
write(pPath, { peak: 0, samples: [], deposits: 0, lastEq: 0, lastUpl: 0, lastEqAt: Date.now(), lastVault: 0, netIds: [], at: new Date().toISOString() });
console.log('equity-peak-live: peak/deposits/samples zeroed (backup .bak-vaultreset) — kill-switch clears next cycle');

// ---- 3. pimp war: align the vault KPI epoch with the vault itself ----
const wPath = `${S}/pimp-war.json`;
const w = load(wPath);
w.vaultHouse = 0;
w.vaultSeen = [];
write(wPath, w);
console.log('pimp-war: house pot + vaultSeen reset — KPI epoch matches vault epoch');
