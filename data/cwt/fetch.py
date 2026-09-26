import json, os, time
from youtube_transcript_api import YouTubeTranscriptApi

eps = [l.strip().split('|',1) for l in open('data/cwt/episodes.txt', encoding='utf-8') if '|' in l]
os.makedirs('data/cwt/transcripts', exist_ok=True)
os.makedirs('data/cwt/failed', exist_ok=True)
api = YouTubeTranscriptApi()
ok = fail = skip = 0
for vid, title in eps:
    out = f'data/cwt/transcripts/{vid}.txt'
    marker = f'data/cwt/failed/{vid}.fail'
    if os.path.exists(out) and os.path.getsize(out) > 1000:
        skip += 1; continue
    if os.path.exists(marker):
        fail += 1; continue
    for attempt in range(4):
        try:
            tr = api.fetch(vid, languages=['en','en-US','en-GB'])
            text = ' '.join(s.text.replace('\n',' ') for s in tr)
            open(out,'w',encoding='utf-8').write(json.dumps({'id':vid,'title':title,'chars':len(text)})+'\n'+text)
            ok += 1
            print(f'[{ok+fail+skip}/{len(eps)}] {vid} {len(text)}ch {title[:55]}', flush=True)
            break
        except Exception as e:
            em = str(e)
            if 'block' in em.lower() or 'too many' in em.lower() or '429' in em:
                wait = 60 * (attempt + 1)
                print(f'{vid} blocked — backing off {wait}s (try {attempt+1})', flush=True)
                time.sleep(wait)
                continue
            if attempt == 3:
                open(marker,'w').write(em[:200]); fail += 1
                print(f'[{ok+fail+skip}/{len(eps)}] {vid} FAIL {em[:70]}', flush=True)
            else:
                time.sleep(4)
    time.sleep(3.5)
print(f'DONE ok={ok} fail={fail} skip={skip}')
