#!/usr/bin/env node
// exchange/bybit-oauth.mjs — Bybit's official OAuth flow for AI agents (Path D).
//
// API-key creation on this account returns ret_code 10024 ("regulatory
// restrictions"). Bybit's sanctioned route for an agent is OAuth, which issues
// credentials for an ISOLATED AI sub-account — withdrawals and main-account
// balances are out of scope — with no manual key.
//
// Implemented from Bybit's published spec rather than by executing their remote
// oauth.js, so the security-relevant logic is auditable here:
//   authorize  https://testnet.bybit.com/oauth
//   token      POST https://api2-testnet.bybit.com/oauth/v1/public/access_token
//   accounts   GET  https://api2-testnet.bybit.com/oauth/v1/resource/restrict/ai_accounts
//   PKCE       code_challenge = base64url(sha256(code_verifier)), method S256
//
// Usage:
//   node bybit-oauth.mjs start                  # URL, wait, exchange, list sub-accounts
//   node bybit-oauth.mjs select <sub_member_id> # fetch credentials for your choice
//   node bybit-oauth.mjs create                 # create an AI sub-account (max 5)
//
// Hard rules honoured: never auto-select or auto-create a sub-account, and never
// print a full key, secret, or token.
import '../load-env.mjs'; // canonical .env loader; SENTINEL_EXEC picks the environment
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ENV_NAME = (process.env.SENTINEL_EXEC || 'testnet').toLowerCase();
const HOSTS = {
  mainnet: { authorize: 'https://www.bybit.com/oauth', api: 'https://api2.bybit.com' },
  testnet: { authorize: 'https://testnet.bybit.com/oauth', api: 'https://api2-testnet.bybit.com' },
};
if (!HOSTS[ENV_NAME]) {
  console.error('unsupported env: ' + ENV_NAME + ' (use testnet or mainnet)');
  process.exit(2);
}
const HOST = HOSTS[ENV_NAME];
const CLIENT_ID = 'ai-agent';
const CRED_DIR = process.env.BYBIT_CRED_DIR || path.join(os.homedir(), '.bybit');
const CRED_FILE = path.join(CRED_DIR, 'oauth_token.json');
const PORT = +(process.env.BYBIT_OAUTH_PORT || 9876);
const TIMEOUT_MS = 10 * 60 * 1000; // user may need to fetch a TOTP; PKCE+state bound the risk

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const maskKey = (k) => (k ? k.slice(0, 5) + '...' + k.slice(-4) : 'n/a');
const maskSecret = (s) => (s ? '***...' + s.slice(-5) : 'n/a');
const out = (o) => console.log(JSON.stringify(o, null, 2));

const saveCred = (d) => {
  fs.mkdirSync(CRED_DIR, { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(d, null, 2), { mode: 0o600 });
};
const loadCred = () => {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')); } catch { return null; }
};

async function exchangeToken(code, verifier) {
  const body = new URLSearchParams({ client_id: CLIENT_ID, code, code_verifier: verifier }).toString();
  const r = await fetch(HOST.api + '/oauth/v1/public/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  const rc = j.retCode ?? j.ret_code;
  if (rc !== undefined && rc !== 0) return { error: j.retMsg || j.ret_msg || 'token exchange failed', retCode: rc };
  const t = j.result || j;
  const cred = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    created_at: Math.floor(Date.now() / 1000),
    expires_in: t.expires_in || 86400,
    refresh_token_expires_in: t.refresh_token_expires_in || 2592000,
    env: ENV_NAME,
  };
  saveCred(cred);
  return { ok: true, cred };
}

// ai_accounts returns result as { accounts: [...] } — assuming a bare array
// is what crashed the first run with "(acc.list || []).map is not a function".
const normalizeList = (r) => {
  if (!r) return [];
  if (Array.isArray(r)) return r;
  if (Array.isArray(r.accounts)) return r.accounts;
  if (Array.isArray(r.list)) return r.list;
  if (Array.isArray(r.result)) return r.result;
  if (typeof r === 'object') return Object.values(r).filter((x) => x && typeof x === 'object' && x.sub_member_id !== undefined);
  return [];
};

async function aiAccounts(token, query = '') {
  const r = await fetch(HOST.api + '/oauth/v1/resource/restrict/ai_accounts' + query, {
    headers: { Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  const rc = j.retCode ?? j.ret_code;
  if (rc !== undefined && rc !== 0) return { error: j.retMsg || j.ret_msg || 'ai_accounts failed', retCode: rc };
  return { ok: true, list: normalizeList(j.result ?? j) };
}

function start() {
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = crypto.randomBytes(16).toString('hex');
  const redirect = 'http://127.0.0.1:' + PORT + '/callback';
  const url = HOST.authorize +
    '?client_id=' + CLIENT_ID +
    '&response_type=code' +
    '&scope=ai-account' +
    '&state=' + state +
    '&redirect_uri=' + encodeURIComponent(redirect) +
    '&code_challenge=' + challenge +
    '&code_challenge_method=S256';

  let settled = false;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404); return res.end(); }
    if (settled) { res.writeHead(200); return res.end('already handled'); }
    settled = true;
    const gotState = u.searchParams.get('state');
    const code = u.searchParams.get('code');
    const err = u.searchParams.get('error');
    if (err || !code) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h3>Authorization failed</h3><p>' + (err || 'no code returned') + '</p>');
      finish({ error: 'authorization_failed', detail: err || 'no code returned' });
      return;
    }
    if (gotState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h3>State mismatch</h3>');
      finish({ error: 'state_mismatch' });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h3>Authorized</h3><p>You can close this tab. Returning to your agent...</p>');
    finish({ code });
  });

  const finish = async (payload) => {
    try {
      if (payload.error) { out(payload); process.exit(1); }
      const ex = await exchangeToken(payload.code, verifier);
      if (ex.error) { out({ error: ex.error, retCode: ex.retCode, credential_file: CRED_FILE }); process.exit(1); }
      const acc = await aiAccounts(ex.cred.access_token);
      if (acc.error) {
        // 20039 = 2FA not bound; terminal per Bybit's spec.
        out({ error: acc.error, retCode: acc.retCode, terminal: acc.retCode === 20039, credential_file: CRED_FILE });
        process.exit(acc.retCode === 20039 ? 4 : 1);
      }
      out({
        ok: true, env: ENV_NAME, token_expires_in: ex.cred.expires_in,
        credential_file: CRED_FILE,
        ai_sub_accounts: (acc.list || []).map((a, i) => ({
          n: i + 1, sub_member_id: a.sub_member_id,
          name: a.subaccount_name || a.name || '(unnamed)',
          api_key: maskKey(a.api_key), has_credentials: !!a.api_key,
        })),
        next: 'user must choose one, then: node bybit-oauth.mjs select <sub_member_id>',
      });
      process.exit(0);
    } catch (e) {
      out({ error: String(e && e.message) });
      process.exit(1);
    } finally { server.close(); }
  };

  server.on('error', (e) => { out({ error: 'port_bind_failed: ' + e.message, authorize_url: url }); process.exit(1); });
  server.listen(PORT, '127.0.0.1', () => {
    console.error('callback listening on ' + redirect);
    out({ authorize_url: url, callback: redirect, credential_file: CRED_FILE });
  });
  setTimeout(() => {
    if (!settled) { out({ error: 'timeout', note: 'no callback within 10 minutes' }); server.close(); process.exit(1); }
  }, TIMEOUT_MS).unref?.();
}

async function select(subMemberId) {
  const cred = loadCred();
  if (!cred || !cred.access_token) { out({ error: 'no stored token — run: node bybit-oauth.mjs start' }); process.exit(1); }
  const acc = await aiAccounts(cred.access_token, '?sub_member_id=' + encodeURIComponent(subMemberId));
  if (acc.error) { out({ error: acc.error, retCode: acc.retCode }); process.exit(1); }
  const acct = acc.list[0];
  if (!acct || !acct.api_key) { out({ error: 'no api_key in response', returned: acc.list.length }); process.exit(1); }

  const envFile = process.env.SENTINEL_TESTNET_ENV_FILE || '.env.bybit-testnet';
  fs.writeFileSync(envFile, [
    '# Bybit AI sub-account credentials — OAuth-issued. NEVER COMMIT.',
    '# Regenerate with: node scripts/exchange/bybit-oauth.mjs start',
    'BYBIT_TESTNET_API_KEY=' + acct.api_key,
    'BYBIT_TESTNET_API_SECRET=' + acct.api_secret,
    'SENTINEL_EXCHANGE=bybit',
    'SENTINEL_EXEC=testnet',
    '',
  ].join('\n'), { mode: 0o600 });
  cred['ai-account'] = { sub_member_id: acct.sub_member_id, api_key: acct.api_key, api_secret: acct.api_secret };
  saveCred(cred);

  out({
    ok: true, sub_member_id: acct.sub_member_id,
    api_key: maskKey(acct.api_key), api_secret: maskSecret(acct.api_secret),
    written_to: envFile, credential_file: CRED_FILE,
    next: 'set -a && . ./' + envFile + ' && set +a && node scripts/exchange/prove-isolation.mjs',
  });
}

const cmd = process.argv[2];
if (cmd === 'start') start();
else if (cmd === 'list') {
  const c0 = loadCred();
  if (!c0 || !c0.access_token) { out({ error: 'no stored token — run: node bybit-oauth.mjs start' }); process.exit(1); }
  aiAccounts(c0.access_token).then((r) => {
    if (r.error) { out({ error: r.error, retCode: r.retCode }); process.exit(1); }
    out({ count: r.list.length, accounts: r.list.map((a, i) => ({
      n: i + 1, sub_member_id: a.sub_member_id,
      name: a.subaccount_name || a.name || '(unnamed)', api_key: maskKey(a.api_key),
    })), next: r.list.length ? 'choose one: node bybit-oauth.mjs select <sub_member_id>'
      : 'none yet — create one with: node bybit-oauth.mjs create' });
  });
}
else if (cmd === 'select') select(process.argv[3]);
else if (cmd === 'create') {
  const cred = loadCred();
  if (!cred || !cred.access_token) { out({ error: 'no stored token — run: node bybit-oauth.mjs start' }); process.exit(1); }
  aiAccounts(cred.access_token, '?is_create=true').then((r) => {
    if (r.error) { out({ error: r.error, retCode: r.retCode }); process.exit(1); }
    const a = r.list[0];
    out({ ok: true, sub_member_id: a?.sub_member_id, api_key: maskKey(a?.api_key),
      next: 'node bybit-oauth.mjs select ' + a?.sub_member_id });
  });
} else {
  console.error('usage: bybit-oauth.mjs start | list | select <sub_member_id> | create');
  process.exit(2);
}
