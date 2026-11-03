#!/usr/bin/env python3
# code-drift.py - every 10 min: lists server code that differs from GitHub main (read-only).
# Drift means someone bypassed deploy-from-repo.py. Writes api/code-drift.json.
import hashlib, json, os, re, time
ROOT, PB = '/opt/sentinel', '/opt/pushbot'
INC = re.compile('^(scripts/(?!node_modules/|__pycache__/|retired/|exchange/node_modules/).+\\.(mjs|js|cjs|py|sh)|scripts/(package(-lock)?\\.json|[\\w-]+\\.example\\.json)|deploy/.+|[^/]+\\.(mjs|js|html|css|cmd|webmanifest|txt|xml)|README\\.md|PITCH\\.md)$'); EXC = re.compile('(\\.bak|\\.pre-|\\.pre[a-z]*$|\\.old|\\.tmp$|\\.session|tg-config\\.json$|\\.env|secret|\\.pem$|\\.key$|keypair|wallet.*\\.json$|id_rsa|AGENTS\\.md$)', re.I)
sha = lambda p: hashlib.sha1(open(p, 'rb').read()).hexdigest()
def files(base):
    out = set()
    for dp, dn, fn in os.walk(base):
        dn[:] = [d for d in dn if d not in ('node_modules', '.venv', '.git', '__pycache__', 'api', 'state', 'vendor', 'logs', 'retired')]
        for f in fn:
            rel = os.path.relpath(os.path.join(dp, f), base)
            if INC.match(rel) and not EXC.search(rel): out.add(rel)
    return out
s, r = files(ROOT), files(PB)
drift = sorted(x for x in s & r if sha(f'{ROOT}/{x}') != sha(f'{PB}/{x}'))
only_server = sorted(s - r)
out = {'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'ok': not drift and not only_server,
       'drifted': [{'path': x, 'serverMtime': time.strftime('%Y-%m-%dT%H:%MZ', time.gmtime(os.path.getmtime(f'{ROOT}/{x}')))} for x in drift],
       'notInRepo': only_server[:200],
       'rule': 'code changes go to GitHub main, then: sudo python3 /opt/sentinel/scripts/deploy-from-repo.py'}
tmp = f'{ROOT}/api/code-drift.json.tmp.{os.getpid()}'; json.dump(out, open(tmp, 'w'), indent=1); os.replace(tmp, f'{ROOT}/api/code-drift.json')
print('code-drift:', 'clean' if out['ok'] else f'{len(drift)} drifted, {len(only_server)} not in repo')
