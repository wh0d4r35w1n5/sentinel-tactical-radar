import json, os, re, glob, collections

# doctrine themes -> keyword families (episode counts = evidence weight)
THEMES = {
  'cut_losers_fast': ['cut your losses','cut losses','get out quick','small loss','tight stop','honor your stop','stop loss'],
  'let_winners_run': ['let winners run','let your winners','ride the trend','runner','trail your','trailing stop','hold winners'],
  'position_sizing': ['position sizing','position size','size your','risk per trade','percent risk','one percent','1% risk','kelly'],
  'survival_first': ['stay in the game','survival','protect capital','capital preservation','blow up','ruin'],
  'edge_evidence': ['edge','positive expectancy','expectancy','backtest','sample size','statistically','probability'],
  'discipline_process': ['discipline','process','routine','consistency','plan','rules-based','systematic'],
  'journal_review': ['journal','track record','review your trades','post-mortem','log your'],
  'overtrading': ['overtrad','too many trades','fewer trades','selective','patience','wait for'],
  'loss_streak_size': ['reduce size','size down','losing streak','drawdown','after a loss','revenge'],
  'avoid_leverage': ['leverage','overleverag','too much size','margin call','liquidat'],
  'dont_average_losers': ['average down','add to a loser','averaging down','double down','adding to losers'],
  'risk_reward': ['risk reward','risk to reward','asymmetr','r multiple','r-multiple','three to one','two to one'],
  'regime_adapt': ['regime','market conditions','different environment','adapt','when the market changes','volatility regime'],
  'emotion_control': ['emotion','fear','greed','fomo','tilt','psychology','ego'],
  'know_why': ['thesis','why am i in','reason for the trade','conviction','edge in this trade'],
}
quotes = {k: [] for k in THEMES}
counts = collections.Counter()
eps_meta = []
files = glob.glob('data/cwt/transcripts/*.txt')
for fp in files:
    lines = open(fp, encoding='utf-8', errors='ignore').read().split('\n', 1)
    meta = json.loads(lines[0]); text = lines[1].lower() if len(lines)>1 else ''
    eps_meta.append({'id': meta['id'], 'title': meta['title'], 'chars': meta['chars']})
    for k, kws in THEMES.items():
        hit = False
        for kw in kws:
            m = re.search(re.escape(kw), text)
            if m:
                hit = True
                if len(quotes[k]) < 3:
                    a = max(0, m.start()-120); quotes[k].append({'ep': meta['title'][:70], 'q': text[a:m.end()+140]})
        if hit: counts[k] += 1
eps_meta.sort(key=lambda x: x['id'])
out = {
  'source': 'Chat With Traders — YouTube transcripts (auto-captions)',
  'episodes': len(eps_meta),
  'themeHits': dict(counts),
  'coveragePct': {k: round(v/max(1,len(eps_meta))*100,1) for k,v in counts.items()},
  'quotes': quotes,
}
json.dump(out, open('api/cwt-wisdom.json','w'), indent=1)
print('episodes:', len(eps_meta))
for k,v in counts.most_common(): print(f'  {k:20s} {v:3d} eps')
