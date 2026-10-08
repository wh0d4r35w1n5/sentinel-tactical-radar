"""Render before/after trade charts for Telegram promo posts.
Fetches public Bitget candles, draws dark-theme candlesticks with
entry/exit markers, MFE line, and a stats banner. Pure Pillow."""
import json, urllib.request, math
from PIL import Image, ImageDraw, ImageFont

BG = (13, 17, 23)
GRID = (33, 38, 45)
UP = (38, 166, 91)
DN = (231, 76, 60)
TXT = (230, 237, 243)
DIM = (140, 150, 160)
GOLD = (240, 185, 11)
BLUE = (88, 156, 255)

W, H = 1100, 720
BANNER = 96
PADL, PADR, PADB = 20, 120, 34

def font(sz, bold=True):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",):
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            continue
    return ImageFont.load_default()

def candles(sym, gran="5m", limit=200):
    url = ("https://api.bitget.com/api/v2/mix/market/candles?"
           "symbol=%s&productType=USDT-FUTURES&granularity=%s&limit=%d" % (sym, gran, limit))
    req = urllib.request.Request(url, headers={"User-Agent": "sentinel/1.0"})
    rows = json.load(urllib.request.urlopen(req, timeout=15))["data"]
    # rows: [ts, open, high, low, close, baseVol, quoteVol] newest first
    out = [{"t": int(r[0]), "o": float(r[1]), "h": float(r[2]), "l": float(r[3]), "c": float(r[4])}
           for r in rows]
    return sorted(out, key=lambda x: x["t"])

def fmt_px(p):
    if p >= 1000: return f"{p:,.1f}"
    if p >= 10: return f"{p:,.2f}"
    return f"{p:,.4f}"

def render(sym, side, entry, exit_, mfe_px, title, stats, out_png, gran="5m"):
    cs = candles(sym, gran, 160)
    # ensure entry/exit window visible: trim to around the trade if possible
    n = len(cs)
    w_px = W - PADL - PADR
    cw = max(3, w_px // n)
    hi = max(c["h"] for c in cs)
    lo = min(c["l"] for c in cs)
    for v in (entry, exit_, mfe_px):
        if v:
            hi = max(hi, v); lo = min(lo, v)
    pad = (hi - lo) * 0.08 or hi * 0.01
    hi += pad; lo -= pad
    ch_h = H - BANNER - PADB
    def Y(p): return BANNER + ch_h * (1 - (p - lo) / (hi - lo))
    img = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(img)
    # grid + right price labels
    f_sm = font(15, False)
    for i in range(6):
        p = lo + (hi - lo) * i / 5
        y = Y(p)
        dr.line([(PADL, y), (W - PADR, y)], fill=GRID)
        dr.text((W - PADR + 8, y - 8), fmt_px(p), font=f_sm, fill=DIM)
    # candles
    for i, c in enumerate(cs):
        x = PADL + i * cw
        col = UP if c["c"] >= c["o"] else DN
        dr.line([(x + cw // 2, Y(c["h"])), (x + cw // 2, Y(c["l"]))], fill=col, width=1)
        yo, yc = Y(c["o"]), Y(c["c"])
        top, bot = min(yo, yc), max(yo, yc)
        if bot - top < 1: bot = top + 1
        dr.rectangle([x + 1, top, x + cw - 1, bot], fill=col)
    def hline(p, col, label, dash=True):
        if not p: return
        y = Y(p)
        if dash:
            x = PADL
            while x < W - PADR:
                dr.line([(x, y), (min(x + 10, W - PADR), y)], fill=col, width=2)
                x += 18
        else:
            dr.line([(PADL, y), (W - PADR, y)], fill=col, width=2)
        dr.text((W - PADR + 8, y - 18), label, font=font(14), fill=col)
    hline(entry, BLUE, "ENTRY " + fmt_px(entry))
    if mfe_px:
        hline(mfe_px, GOLD, "PEAK " + fmt_px(mfe_px))
    if exit_:
        hline(exit_, UP if (exit_ > entry) == (side == "long") else DN, "EXIT " + fmt_px(exit_))
    # entry marker arrow on last... skip - lines carry it
    # banner
    f_t = font(30); f_s = font(20, False)
    dr.rectangle([0, 0, W, BANNER], fill=(17, 22, 29))
    dr.text((24, 14), title, font=f_t, fill=TXT)
    dr.text((24, 56), stats, font=f_s, fill=GOLD)
    dr.text((W - PADR - 60, BANNER + ch_h + 6),
            "SENTINEL  ·  live evidence  ·  54-66-217-111.sslip.io/gallery.html",
            font=font(13, False), fill=DIM)
    img.save(out_png)
    print("wrote", out_png, f"({n} candles {gran})")

if __name__ == "__main__":
    jobs = json.load(open("/tmp/chart-jobs.json"))
    for j in jobs:
        render(**j)
