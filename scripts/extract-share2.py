import re, json, io

raw = open(r'C:/Users/beaue/AppData/Local/Temp/will-share2.html', encoding='utf-8', errors='replace').read()
out = io.open(r'C:/Users/beaue/AppData/Local/Temp/will-share2.txt', 'w', encoding='utf-8')

cands = []
for m in re.finditer(r'"((?:[^"\\]|\\.){120,})"', raw):
    s = m.group(1)
    try:
        t = json.loads('"' + s + '"')
    except Exception:
        continue
    if any(k in t for k in ('SENTINEL', 'Sentinel', 'sentinel', 'Kelly', 'vault', 'on-chain', 'onchain', 'Pimp', 'trade', 'profit', 'evaluation', 'strategy')):
        cands.append(t)

seen = set()
n = 0
for t in cands:
    key = t[:80]
    if key in seen:
        continue
    seen.add(key)
    n += 1
    out.write('=== CHUNK %d ===\n' % n)
    out.write(t + '\n\n')

out.close()
print('chunks:', n)
