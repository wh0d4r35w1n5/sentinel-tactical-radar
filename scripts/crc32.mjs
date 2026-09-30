// crc32.mjs — shared integrity layer. IEEE 802.3 CRC32, dependency-free,
// Node 18-compatible (zlib.crc32 doesn't exist until Node 20/22).
//
// Every audited file write records {crc32, bytes, ts} into
// state/checksums.json — the integrity manifest. Readers recompute and
// compare; a mismatch means corruption or tamper, never silently trusted.
// The manifest is the root of trust for state integrity (it is itself
// written atomically).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANIFEST = path.join(ROOT, 'state', 'checksums.json');

const T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export const crc32 = (buf) => {
  const b = typeof buf === 'string' ? Buffer.from(buf) : buf;
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
export const crc32hex = (buf) => crc32(buf).toString(16).padStart(8, '0');

const loadManifest = () => {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return { files: {} }; }
};
const saveManifest = (m) => {
  try {
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
    const tmp = MANIFEST + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m));
    fs.renameSync(tmp, MANIFEST);
  } catch {}
};
const relKey = (file) => {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  return rel.startsWith('..') ? path.basename(file) : rel;
};

// manifest read-modify-write MUST be serialized — scanner, exec, guard and
// the verifier all write through here; an interleaved load→save drops the
// other writer's entry and the victim file then verifies as "corrupt".
// wx-create is the atomic take; stale locks (killed writer) break at 10s,
// callers give up waiting at 4s and fall back to an unlocked write (the
// manifest entry may then lose a race, but the file itself is never blocked).
const LOCK = MANIFEST + '.lock';
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
const acquireLock = () => {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      return fs.openSync(LOCK, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 10000) { fs.unlinkSync(LOCK); continue; } } catch {}
      Atomics.wait(SLEEP, 0, 0, 5);
    }
  }
  return null;
};

// record a freshly-written file's checksum into the manifest
export const integrityNote = (file, content) => {
  try {
    const bytes = typeof content === 'string' ? content : fs.readFileSync(file);
    const fd = acquireLock();
    try {
      const m = loadManifest();
      m.files ||= {};
      m.files[relKey(file)] = { crc32: crc32hex(bytes), bytes: bytes.length, ts: Date.now() };
      m.updatedAt = new Date().toISOString();
      saveManifest(m);
      return m.files[relKey(file)].crc32;
    } finally {
      if (fd != null) { try { fs.closeSync(fd); fs.unlinkSync(LOCK); } catch {} }
    }
  } catch { return null; }
};

// verify a file against the manifest — returns {ok, expected, actual}
// unregistered files return {ok:null} so callers can distinguish
// "unchecked" from "corrupt"
export const integrityCheck = (file) => {
  try {
    const entry = loadManifest().files?.[relKey(file)];
    if (!entry) return { ok: null };
    const actual = crc32hex(fs.readFileSync(file));
    if (actual === entry.crc32) return { ok: true, expected: entry.crc32, actual };
    // write-in-flight grace: writeCheckedJson renames the file THEN notes
    // the manifest — a verify landing in that ~ms gap (or against a writer
    // that hasn't noted yet) reads new-file/old-entry. That is not
    // corruption. Grace fresh mismatches for 120s; a writer that never
    // notes still flags once the file ages past the window.
    try {
      const mt = fs.statSync(file).mtimeMs;
      if (entry.ts && mt > entry.ts && mt - entry.ts < 120e3)
        return { ok: null, pending: true, expected: entry.crc32, actual };
    } catch {}
    return { ok: false, expected: entry.crc32, actual };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
};

// drop-in for the scripts' writeJson — atomic write + manifest record.
// Files outside state//api (logs, tmp) can pass {audit:false}.
export const writeCheckedJson = (file, obj, opts = {}) => {
  const body = JSON.stringify(obj, null, 1);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  if (opts.audit !== false && /state|api/.test(relKey(file))) integrityNote(file, body);
  return file;
};
