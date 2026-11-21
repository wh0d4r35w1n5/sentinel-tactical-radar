#!/usr/bin/env node
// Watchdog GOD-verdict parser — fail closed, always.
// Extracted from .github/workflows/sentinel-watchdog.yml (2026-11-14) so the
// fixtures are committed and executed in CI (step: node scripts/watchdog-verdict.mjs --selftest).
//
// Usage:  cat api/god.json | node scripts/watchdog-verdict.mjs   -> prints "pass" or "FAIL"
//         node scripts/watchdog-verdict.mjs --selftest           -> runs fixture corpus
//
// Fail-closed coverage: BROKEN/ATTENTION/unknown verdicts, nested checks[]
// failures (array AND object shapes), numeric top-level `fail`, malformed
// failures/fails shapes (non-array truthy trips), malformed checks shape,
// missing verdict, malformed JSON.

const BAD = /FAIL|BROKEN|CRITICAL|DOWN|UNHEALTHY/;
const HEALTHY = /^(PERFECT|PASS|OK|HEALTHY|GREEN|GOOD)$/;

export function verdict(json) {
  let j;
  try { j = JSON.parse(json); } catch { return 'FAIL'; }
  if (!j || typeof j !== 'object') return 'FAIL';
  const v = String(j.verdict || j.status || '').toUpperCase();
  let nestedBad = false;
  const ck = j.checks;
  if (Array.isArray(ck)) {
    nestedBad = ck.some(c => BAD.test(String((c && (c.status || c.state || c.verdict)) || '')));
  } else if (ck && typeof ck === 'object') {
    nestedBad = Object.values(ck).some(c => {
      const st = (c && typeof c === 'object') ? (c.status || c.state || c.verdict || '') : c;
      return BAD.test(String(st));
    });
  }
  // checks present but neither array nor object -> malformed shape, fail closed
  const checksMalformed = ck != null && typeof ck !== 'object';
  // failures/fails: absent|null|[] = clean. Non-empty array = declared
  // failure. ANY other truthy shape (object, string, number) is malformed
  // -> fail closed (2026-11-14: 'failures:{"x":1}' used to slip .length>0).
  const fl = j.failures ?? j.fails;
  const hasFailures = fl != null ? (Array.isArray(fl) ? fl.length > 0 : true) : false;
  // numeric (or numeric-string) top-level fail counter must be zero/absent
  const fc = j.fail;
  const numericFail = typeof fc === 'number' ? fc > 0
    : (typeof fc === 'string' && fc.trim() !== '' && Number(fc) > 0);
  const healthy = HEALTHY.test(v);
  return (healthy && !nestedBad && !hasFailures && !numericFail && !checksMalformed) ? 'pass' : 'FAIL';
}

const FIXTURES = [
  ['{"verdict":"PERFECT"}', 'pass'],
  ['{"verdict":"PASS","checks":[]}', 'pass'],
  ['{"verdict":"PERFECT","failures":[]}', 'pass'],
  ['{"verdict":"OK","checks":{"a":{"status":"HEALTHY"}}}', 'pass'],
  ['{"verdict":"BROKEN"}', 'FAIL'],
  ['{"verdict":"ATTENTION"}', 'FAIL'],
  ['{"verdict":"WEIRD_UNKNOWN"}', 'FAIL'],
  ['{"status":"DOWN"}', 'FAIL'],
  ['{}', 'FAIL'],
  ['not json at all', 'FAIL'],
  ['{"verdict":"PERFECT","fail":3}', 'FAIL'],
  ['{"verdict":"PERFECT","fail":"2"}', 'FAIL'],
  ['{"verdict":"PERFECT","fail":0}', 'pass'],
  ['{"verdict":"PERFECT","failures":["edge-death"]}', 'FAIL'],
  ['{"verdict":"PERFECT","fails":["x"]}', 'FAIL'],
  ['{"verdict":"PERFECT","failures":{"risk":"bleed"}}', 'FAIL'],
  ['{"verdict":"PERFECT","failures":"none-really"}', 'FAIL'],
  ['{"verdict":"PERFECT","checks":[{"name":"god","status":"FAIL"}]}', 'FAIL'],
  ['{"verdict":"PERFECT","checks":{"risk":{"state":"BROKEN"}}}', 'FAIL'],
  ['{"verdict":"PERFECT","checks":{"risk":"FAIL"}}', 'FAIL'],
  ['{"verdict":"PERFECT","checks":"healthy-trust-me"}', 'FAIL'],
  ['{"verdict":"PERFECT","checks":[{"status":"OK"},{"verdict":"CRITICAL"}]}', 'FAIL'],
];

if (process.argv[2] === '--selftest') {
  let bad = 0;
  for (const [input, want] of FIXTURES) {
    const got = verdict(input);
    if (got !== want) { bad++; console.error(`FIXTURE FAIL: ${input} -> ${got} (want ${want})`); }
  }
  console.log(`watchdog-verdict selftest: ${FIXTURES.length - bad}/${FIXTURES.length} fixtures pass`);
  process.exit(bad ? 1 : 0);
}

let s = '';
process.stdin.on('data', d => s += d).on('end', () => console.log(verdict(s)));
