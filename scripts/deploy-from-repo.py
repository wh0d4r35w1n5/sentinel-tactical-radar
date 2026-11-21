#!/usr/bin/env python3
# deploy-from-repo.py - the ONLY way code reaches /opt/sentinel (operator order 2026-11-04, Beau).
# Refreshes /opt/pushbot to GitHub main, copies every code file that differs into /opt/sentinel
# (backup first, syntax-checked, restored on failure), then restarts sentinel-rapid.
# Usage: sudo python3 /opt/sentinel/scripts/deploy-from-repo.py [--dry]
import os, re, shutil, subprocess, sys, time, hashlib
ROOT, PB, TS, DRY = '/opt/sentinel', '/opt/pushbot', time.strftime('%Y%m%d-%H%M%S'), '--dry' in sys.argv
INC = re.compile('^(scripts/(?!node_modules/|__pycache__/|retired/|exchange/node_modules/).+\\.(mjs|js|cjs|py|sh)|scripts/(package(-lock)?\\.json|[\\w-]+\\.example\\.json)|deploy/.+|[^/]+\\.(mjs|js|html|css|cmd|webmanifest|txt|xml)|README\\.md|PITCH\\.md)$'); EXC = re.compile('(\\.bak|\\.pre-|\\.pre[a-z]*$|\\.old|\\.tmp$|\\.session|tg-config\\.json$|\\.env|secret|\\.pem$|\\.key$|keypair|wallet.*\\.json$|id_rsa|AGENTS\\.md$)', re.I)
g = lambda *a: subprocess.run(['sudo', '-u', 'ubuntu', 'git', '-C', PB, *a], capture_output=True, text=True)
if not os.path.exists(f'{PB}/deploy/SOURCE_OF_TRUTH.md'):
    sys.exit('refusing: the repo has no deploy/SOURCE_OF_TRUTH.md - the server snapshot was never published, deploying would overwrite newer server code')
subprocess.run(['systemctl', 'stop', 'sentinel-push.timer'])
try:
    g('fetch', 'origin', 'main', '-q'); g('reset', '--hard', 'origin/main', '-q')
    head = g('log', '-1', '--format=%h %s').stdout.strip(); print('repo', head)
    sha = lambda p: hashlib.sha1(open(p, 'rb').read()).hexdigest()
    changed = []
    for dp, dn, fn in os.walk(PB):
        dn[:] = [d for d in dn if d not in ('node_modules', '.git', 'api', 'state', 'vendor', 'retired')]
        for f in fn:
            rel = os.path.relpath(os.path.join(dp, f), PB)
            if not INC.match(rel) or EXC.search(rel): continue
            src, dst = os.path.join(PB, rel), os.path.join(ROOT, rel)
            if not os.path.exists(dst) or sha(src) != sha(dst): changed.append(rel)
    print(len(changed), 'file(s) differ:', ', '.join(changed[:40]))
    if DRY or not changed: sys.exit(0)
    bdir = f'/opt/sentinel-archive/deploy-{TS}'
    for rel in changed:
        src, dst = os.path.join(PB, rel), os.path.join(ROOT, rel)
        if os.path.exists(dst): os.makedirs(os.path.dirname(f'{bdir}/{rel}'), exist_ok=True); shutil.copy2(dst, f'{bdir}/{rel}')
        os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copy2(src, dst)
        chk = ['node', '--check', dst] if dst.endswith(('.mjs', '.js', '.cjs')) else [sys.executable, '-m', 'py_compile', dst] if dst.endswith('.py') else None
        if chk and subprocess.run(chk, capture_output=True).returncode:
            if os.path.exists(f'{bdir}/{rel}'): shutil.copy2(f'{bdir}/{rel}', dst)
            print('SYNTAX FAIL - kept server version:', rel)
    open(f'{ROOT}/api/last-deploy.json', 'w').write('{"at": "%s", "repo": "%s", "files": %d}' % (TS, head.replace('"', "'"), len(changed)))
    subprocess.run(['systemctl', 'restart', 'sentinel-rapid'])
    subprocess.run([sys.executable, f'{ROOT}/scripts/code-drift.py'])
    print('deployed', len(changed), 'file(s); backups in', bdir, '; sentinel-rapid restarted; live-exec picks it up next loop')
finally:
    subprocess.run(['systemctl', 'start', 'sentinel-push.timer'])
