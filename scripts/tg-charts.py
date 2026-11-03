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
    out = [{"t": int(r[0]), "o": float(r[1]), "h": float(r[2]), "l": float(r[3]),
            "c": float(r[4]), "v": float(r[6] or r[5] or 0),
            "qv": float(r[6] or r[5] or 0)}
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
            "SENTINEL  ·  live evidence  ·  52-65-5-228.sslip.io/gallery.html",
            font=font(13, False), fill=DIM)
    img.save(out_png)
    print("wrote", out_png, f"({n} candles {gran})")

def ema(vals, n):
    k = 2.0 / (n + 1)
    e = vals[0]
    out = [e]
    for v in vals[1:]:
        e = v * k + e * (1 - k)
        out.append(e)
    return out

def swing_levels(cs, w=3):
    """recent swing-high / swing-low pivots — S/R context lines"""
    hi, lo = [], []
    for i in range(w, len(cs) - w):
        if all(cs[i]["h"] >= cs[j]["h"] for j in range(i - w, i + w + 1)): hi.append(cs[i]["h"])
        if all(cs[i]["l"] <= cs[j]["l"] for j in range(i - w, i + w + 1)): lo.append(cs[i]["l"])
    return hi, lo

def render_signal(sym, side, entry, sl, tps, out_png, gran="5m", title=None, stats=None):
    """Pre-trade signal chart: candles + EMA20/50 + volume + S/R pivots +
    shaded risk (entry->SL, red) / reward (entry->each TP, green) zones."""
    cs = candles(sym, gran, 160)
    n = len(cs)
    w_px = W - PADL - PADR
    cw = max(3, w_px // n)
    VOL_H = 88
    ch_h = H - BANNER - PADB - VOL_H
    levels = [v for v in [entry, sl] + list(tps or []) if v]
    hi = max([c["h"] for c in cs] + levels)
    lo = min([c["l"] for c in cs] + levels)
    pad = (hi - lo) * 0.07 or hi * 0.01
    hi += pad; lo -= pad
    def Y(p): return BANNER + ch_h * (1 - (p - lo) / (hi - lo))
    img = Image.new("RGB", (W, H), BG)
    # shaded risk/reward zones first (under everything)
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dov = ImageDraw.Draw(ov)
    yE = Y(entry)
    if sl:
        yS = Y(sl)
        dov.rectangle([PADL, min(yE, yS), W - PADR, max(yE, yS)], fill=(231, 76, 60, 40))
    for i, tp in enumerate(tps or []):
        if not tp: continue
        yT = Y(tp)
        dov.rectangle([PADL, min(yE, yT), W - PADR, max(yE, yT)], fill=(38, 166, 91, 26))
    img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
    dr = ImageDraw.Draw(img)
    # grid + right price labels
    f_sm = font(15, False)
    for i in range(6):
        p = lo + (hi - lo) * i / 5
        y = Y(p)
        dr.line([(PADL, y), (W - PADR, y)], fill=GRID)
        dr.text((W - PADR + 8, y - 8), fmt_px(p), font=f_sm, fill=DIM)
    # volume sub-pane
    vmax = max((c["v"] for c in cs), default=0)
    vy0 = BANNER + ch_h
    for i, c in enumerate(cs):
        x = PADL + i * cw
        vh = int(VOL_H * (c["v"] / vmax)) if vmax > 0 else 0
        col = UP if c["c"] >= c["o"] else DN
        if vh > 0:
            dr.rectangle([x + 1, vy0 + VOL_H - vh, x + cw - 1, vy0 + VOL_H], fill=tuple(int(v * 0.35) for v in col))
    dr.line([(PADL, vy0), (W - PADR, vy0)], fill=GRID)
    # candles
    for i, c in enumerate(cs):
        x = PADL + i * cw
        col = UP if c["c"] >= c["o"] else DN
        dr.line([(x + cw // 2, Y(c["h"])), (x + cw // 2, Y(c["l"]))], fill=col, width=1)
        yo, yc = Y(c["o"]), Y(c["c"])
        top, bot = min(yo, yc), max(yo, yc)
        if bot - top < 1: bot = top + 1
        dr.rectangle([x + 1, top, x + cw - 1, bot], fill=col)
    # EMA20 / EMA50 overlays
    for vals, col, lbl in ((ema([c["c"] for c in cs], 20), BLUE, "EMA20"),
                           (ema([c["c"] for c in cs], 50), GOLD, "EMA50")):
        pts = [(PADL + i * cw + cw // 2, Y(v)) for i, v in enumerate(vals)]
        dr.line(pts, fill=col, width=2)
        dr.text((pts[-1][0] + 4, pts[-1][1] - 16), lbl, font=font(13), fill=col)
    # S/R pivot lines (thin, dim)
    hiL, loL = swing_levels(cs)
    for p in (hiL + loL)[-6:]:
        y = Y(p)
        x = PADL
        while x < W - PADR:
            dr.line([(x, y), (min(x + 5, W - PADR), y)], fill=(70, 80, 95), width=1)
            x += 11
    # level lines with labels
    def lvl(p, col, label, dash=True):
        if not p: return
        y = Y(p)
        if dash:
            x = PADL
            while x < W - PADR:
                dr.line([(x, y), (min(x + 10, W - PADR), y)], fill=col, width=2)
                x += 18
        else:
            dr.line([(PADL, y), (W - PADR, y)], fill=col, width=2)
        dr.text((PADL + 4, y - 16), label, font=font(14), fill=col)
    lvl(entry, BLUE, "ENTRY " + fmt_px(entry))
    if sl: lvl(sl, DN, "SL " + fmt_px(sl))
    for i, tp in enumerate(tps or []):
        if tp: lvl(tp, UP, "TP%d %s" % (i + 1, fmt_px(tp)))
    # banner
    f_t = font(30); f_s = font(20, False)
    dr.rectangle([0, 0, W, BANNER], fill=(17, 22, 29))
    dr.text((24, 14), title or ("%s %s" % (side.upper(), sym)), font=f_t, fill=TXT)
    if stats:
        dr.text((24, 56), stats, font=f_s, fill=GOLD)
    # pattern tags belong to render_structure only — this is the plain signal card
    dr.text((W - PADR - 60, BANNER + ch_h + VOL_H - 2),
            "SENTINEL  ·  live signal  ·  52-65-5-228.sslip.io/gallery.html",
            font=font(13, False), fill=DIM)
    img.save(out_png)
    print("wrote", out_png, f"({n} candles {gran})")


def _pivots(cs, lb=2):
    """swing pivots — exec parity: left strictly inside, right inside-eq."""
    hi, lo = [], []
    for i in range(lb, len(cs) - lb):
        r = cs[i]
        if all(cs[i - j]["h"] < r["h"] for j in range(1, lb + 1)) and \
           all(cs[i + j]["h"] <= r["h"] for j in range(1, lb + 1)):
            hi.append((i, r["h"]))
        if all(cs[i - j]["l"] > r["l"] for j in range(1, lb + 1)) and \
           all(cs[i + j]["l"] >= r["l"] for j in range(1, lb + 1)):
            lo.append((i, r["l"]))
    return hi, lo

def _tlfit(pts, n=3):
    """least-squares over the last n pivots -> (m, b, pts) index-space line"""
    pts = pts[-n:]
    if len(pts) < 2:
        return None
    N = len(pts)
    sx = sum(q[0] for q in pts); sy = sum(q[1] for q in pts)
    sxx = sum(q[0] * q[0] for q in pts); sxy = sum(q[0] * q[1] for q in pts)
    den = N * sxx - sx * sx
    if not den:
        return None
    m = (N * sxy - sx * sy) / den
    b = (sy - m * sx) / N
    return m, b, pts

CYAN = (88, 220, 255)
PURP = (200, 140, 255)

def render_structure(sym, side, entry, sl, tps, out_png, gran="15m",
                     break_px=None, stage=None, title=None, stats=None,
                     anchors=None):
    """Wizard card: candles + FITTED trendlines + shaded triangle wedge +
    confirmation markers (break candle, retest touch) + level stack.
    Geometry is recomputed from raw candles — the chart IS the proof."""
    side = (side or "long").lower()
    sgn = 1 if side == "long" else -1
    cs = candles(sym, gran, 160)
    n = len(cs)
    w_px = W - PADL - PADR
    cw = max(3, w_px // n)
    VOL_H = 88
    ch_h = H - BANNER - PADB - VOL_H
    last_px = cs[-1]["c"]
    # a TP 40% overhead must never squash the structure — in-band levels
    # set the scale; off-scale targets become edge tags instead
    BAND = 0.15
    in_band = [v for v in [entry, sl, break_px] + list(tps or [])
               if v and abs(v - last_px) / last_px <= BAND]
    off_top = [t for t in (tps or []) if t and (t - last_px) / last_px > BAND]
    off_bot = [t for t in (tps or []) if t and (last_px - t) / last_px > BAND]
    hi = max([c["h"] for c in cs] + in_band)
    lo = min([c["l"] for c in cs] + in_band)
    pad = (hi - lo) * 0.07 or hi * 0.01
    hi += pad; lo -= pad
    def Y(p): return BANNER + ch_h * (1 - (p - lo) / (hi - lo))
    def X(i): return PADL + i * cw + cw // 2

    # --- detector-anchored geometry first (the exact TLs/marks the exec
    # traded, timestamp-mapped into this candle window); recompute only
    # as fallback for cards that carry no anchors.
    phs, pls = _pivots(cs, 2)
    win = lambda pts: [q for q in pts if q[0] >= n - 48]
    tlU = _tlfit(win(phs), 3)
    tlL = _tlfit(win(pls), 3)
    marks = []
    neckline = None
    if anchors:
        ts2i = {c["t"]: i for i, c in enumerate(cs)}
        def _anch(pts):
            if not pts or len(pts) < 2:
                return None
            i0, i1 = ts2i.get(pts[0][0]), ts2i.get(pts[1][0])
            if i0 is None or i1 is None or i1 == i0:
                return None
            m = (pts[1][1] - pts[0][1]) / (i1 - i0)
            b = pts[0][1] - m * i0
            return (m, b, [(i0, pts[0][1]), (i1, pts[1][1])])
        if anchors.get("upPts") or anchors.get("loPts") or anchors.get("marks") or anchors.get("neckline"):
            tlU = _anch(anchors.get("upPts"))
            tlL = _anch(anchors.get("loPts"))
        marks = [(ts2i.get(t), p, lbl) for t, p, lbl in (anchors.get("marks") or []) if ts2i.get(t) is not None]
        neckline = anchors.get("neckline")
    apex_i = None
    if tlU and tlL and abs(tlU[0] - tlL[0]) > 1e-12:
        apex_i = (tlL[1] - tlU[1]) / (tlU[0] - tlL[0])
    atr = sum(c["h"] - c["l"] for c in cs[-32:]) / min(32, n)
    is_tri = False
    if tlU and tlL and apex_i is not None and apex_i > n - 1 and apex_i - (n - 1) <= 96 and atr > 0:
        h0 = tlU[0] * max(0, n - 48) + tlU[1] - (tlL[0] * max(0, n - 48) + tlL[1])
        h1 = tlU[0] * (n - 1) + tlU[1] - (tlL[0] * (n - 1) + tlL[1])
        is_tri = bool(tlL[0] >= 0.03 * atr and tlU[0] <= 0.05 * atr and h0 > 1.25 * h1 and h1 > 0)
    is_wedge = bool(tlU and tlL and tlU[0] > 0 and tlL[0] > 0 and apex_i is not None and apex_i > n - 1)

    img = Image.new("RGB", (W, H), BG)
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    dov = ImageDraw.Draw(ov)
    # wedge shade — between the two TLs from first shared pivot to apex
    if is_tri:
        i0 = int(max(tlU[2][0][0], tlL[2][0][0]))
        i1 = int(min(apex_i, n + 8))
        upper = [(X(i), Y(tlU[0] * i + tlU[1])) for i in range(i0, i1 + 1)]
        lower = [(X(i), Y(tlL[0] * i + tlL[1])) for i in range(i0, i1 + 1)]
        dov.polygon(upper + lower[::-1], fill=(88, 220, 255, 26))
    # risk/reward zones
    yE = Y(entry) if entry else None
    if entry and sl:
        yS = Y(sl)
        dov.rectangle([PADL, min(yE, yS), W - PADR, max(yE, yS)], fill=(231, 76, 60, 40))
    if entry:
        for tp in (tps or []):
            if not tp: continue
            yT = Y(tp)
            dov.rectangle([PADL, min(yE, yT), W - PADR, max(yE, yT)], fill=(38, 166, 91, 26))
    img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
    dr = ImageDraw.Draw(img)

    # grid + right labels
    f_sm = font(15, False)
    for i in range(6):
        p = lo + (hi - lo) * i / 5
        y = Y(p)
        dr.line([(PADL, y), (W - PADR, y)], fill=GRID)
        dr.text((W - PADR + 8, y - 8), fmt_px(p), font=f_sm, fill=DIM)
    # volume pane
    vmax = max((c["v"] for c in cs), default=0)
    vy0 = BANNER + ch_h
    for i, c in enumerate(cs):
        x = PADL + i * cw
        vh = int(VOL_H * (c["v"] / vmax)) if vmax > 0 else 0
        col = UP if c["c"] >= c["o"] else DN
        if vh > 0:
            dr.rectangle([x + 1, vy0 + VOL_H - vh, x + cw - 1, vy0 + VOL_H],
                         fill=tuple(int(v * 0.35) for v in col))
    dr.line([(PADL, vy0), (W - PADR, vy0)], fill=GRID)
    # candles
    for i, c in enumerate(cs):
        x = PADL + i * cw
        col = UP if c["c"] >= c["o"] else DN
        dr.line([(x + cw // 2, Y(c["h"])), (x + cw // 2, Y(c["l"]))], fill=col, width=1)
        yo, yc = Y(c["o"]), Y(c["c"])
        top, bot = min(yo, yc), max(yo, yc)
        if bot - top < 1: bot = top + 1
        dr.rectangle([x + 1, top, x + cw - 1, bot], fill=col)
    # EMA20/50
    for vals, col, lbl in ((ema([c["c"] for c in cs], 20), BLUE, "EMA20"),
                           (ema([c["c"] for c in cs], 50), GOLD, "EMA50")):
        pts = [(X(i), Y(v)) for i, v in enumerate(vals)]
        dr.line(pts, fill=col, width=2)
        dr.text((pts[-1][0] + 4, pts[-1][1] - 16), lbl, font=font(13), fill=col)
    # --- TRENDLINES (the structure itself) ---
    def draw_tl(tl, col, lbl):
        if not tl: return
        m, b, pts = tl
        i0, i1 = pts[0][0], int(min(apex_i or n + 4, n + 10))
        p0, p1 = (X(i0), Y(m * i0 + b)), (X(i1), Y(m * i1 + b))
        dr.line([p0, p1], fill=col, width=3)
        for q in pts[1:]:
            dr.ellipse([X(q[0]) - 4, Y(q[1]) - 4, X(q[0]) + 4, Y(q[1]) + 4], outline=col, width=2)
        dr.text((min(p1[0], W - PADR - 90), p1[1] - 20 if col == CYAN else p1[1] + 8),
                lbl, font=font(13), fill=col)
    draw_tl(tlU, CYAN, "resistance TL")
    draw_tl(tlL, PURP, "support TL")
    if is_tri and apex_i and apex_i < n + 10:
        ax, ay = X(apex_i), Y(tlU[0] * apex_i + tlU[1])
        dr.line([ax - 5, ay - 5, ax + 5, ay + 5], fill=DIM, width=1)
        dr.line([ax - 5, ay + 5, ax + 5, ay - 5], fill=DIM, width=1)
        dr.text((ax - 14, ay - 18), "apex", font=font(12, False), fill=DIM)
    # pattern marks (LS/H/RS, B1/B2, POLE) + neckline — detector's own anchors
    f_pm = font(14)
    for i, pp, lbl in marks:
        mx, my = X(i), Y(pp)
        dr.ellipse([mx - 6, my - 6, mx + 6, my + 6], outline=PURP, width=2)
        dr.text((mx - 12, my + 9), lbl, font=f_pm, fill=PURP)
    if neckline:
        y = Y(neckline)
        x = PADL
        while x < W - PADR:
            dr.line([(x, y), (min(x + 7, W - PADR), y)], fill=PURP, width=2)
            x += 13
        dr.text((PADL + 4, y + 6), "neckline " + fmt_px(neckline), font=font(13), fill=PURP)
    # --- confirmation markers ---
    f_mk = font(13)
    if break_px:
        iB = next((i for i, c in enumerate(cs)
                   if (c["h"] >= break_px if sgn > 0 else c["l"] <= break_px)), None)
        if iB is not None:
            bx, by = X(iB), Y(break_px)
            dr.ellipse([bx - 7, by - 7, bx + 7, by + 7], outline=GOLD, width=3)
            dr.text((bx - 22, by - 30), "BREAK", font=f_mk, fill=GOLD)
            iR = next((i for i in range(iB + 1, n)
                       if (cs[i]["l"] <= entry if sgn > 0 else cs[i]["h"] >= entry)), None)
            if iR is not None:
                rx, ry = X(iR), Y(entry)
                dr.ellipse([rx - 7, ry - 7, rx + 7, ry + 7], outline=BLUE, width=3)
                dr.text((rx - 24, ry + 10), "RETEST", font=f_mk, fill=BLUE)
    # level stack
    used_ty = []
    def lvl(p, col, label, dash=True):
        if not p: return
        y = Y(p)
        if dash:
            x = PADL
            while x < W - PADR:
                dr.line([(x, y), (min(x + 10, W - PADR), y)], fill=col, width=2)
                x += 18
        else:
            dr.line([(PADL, y), (W - PADR, y)], fill=col, width=2)
        ty = y - 16
        while any(abs(ty - u) < 16 for u in used_ty):
            ty += 18
        used_ty.append(ty)
        dr.text((PADL + 4, ty), label, font=font(14), fill=col)
    if break_px: lvl(break_px, GOLD, "BREAK " + fmt_px(break_px))
    if entry: lvl(entry, BLUE, "ENTRY " + fmt_px(entry))
    if sl: lvl(sl, DN, "SL " + fmt_px(sl))
    for i, tp in enumerate(tps or []):
        if tp and tp in in_band: lvl(tp, UP, "TP%d %s" % (i + 1, fmt_px(tp)))
    # off-scale targets — edge tags, not scale-destroyers
    for j, tp in enumerate(off_top):
        y = BANNER + 6 + j * 18
        dr.text((W - PADR - 210, y), "TP%d %s  ▲" % ((tps or []).index(tp) + 1, fmt_px(tp)),
                font=font(14), fill=UP)
    for j, tp in enumerate(off_bot):
        y = BANNER + ch_h - 24 - j * 18
        dr.text((W - PADR - 210, y), "TP%d %s  ▼" % ((tps or []).index(tp) + 1, fmt_px(tp)),
                font=font(14), fill=DN)
    # banner
    f_t = font(30); f_s = font(20, False)
    dr.rectangle([0, 0, W, BANNER], fill=(17, 22, 29))
    dr.text((24, 14), title or ("%s %s — %s" % (side.upper(), sym, stage or "structure")),
            font=f_t, fill=TXT)
    if stats:
        dr.text((24, 56), stats, font=f_s, fill=GOLD)
    dr.text((W - PADR - 60, BANNER + ch_h + VOL_H - 2),
            "SENTINEL  ·  structure proof  ·  52-65-5-228.sslip.io/gallery.html",
            font=font(13, False), fill=DIM)
    img.save(out_png)
    print("wrote", out_png, f"({n} candles {gran}, tri={is_tri})")

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "signal":
        job = json.load(open(sys.argv[2]))
        render_signal(**job)
    else:
        jobs = json.load(open("/tmp/chart-jobs.json"))
        for j in jobs:
            render(**j)


# ============ TradingView renderer + full indicator stack ============
import json as _json, subprocess as _sp, os as _os, math as _math

TV_RENDER_JS = "/opt/sentinel/tv/tv-render.mjs"

def _ema_series(vals, n):
    k = 2.0 / (n + 1); out = []; e = None
    for i, v in enumerate(vals):
        e = v if e is None else v * k + e * (1 - k)
        if i >= n - 1: out.append((i, e))
    return out

def _rsi(closes, n=14):
    if len(closes) < n + 1: return []
    gains = [0.0] * len(closes); losses = [0.0] * len(closes)
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains[i] = max(d, 0); losses[i] = max(-d, 0)
    ag = sum(gains[1:n + 1]) / n; al = sum(losses[1:n + 1]) / n
    out = [None] * n
    out.append(100 - 100 / (1 + (ag / al if al else 1e9)))
    for i in range(n + 1, len(closes)):
        ag = (ag * (n - 1) + gains[i]) / n
        al = (al * (n - 1) + losses[i]) / n
        out.append(100 - 100 / (1 + (ag / al if al else 1e9)))
    return out

def _macd(closes, f=12, s=26, sig=9):
    ef = _ema_series(closes, f); es = _ema_series(closes, s)
    ef = dict(ef); es = dict(es)
    macd = [(i, ef[i] - es[i]) for i in sorted(es) if i in ef]
    if len(macd) < sig: return [], [], []
    mv = [v for _, v in macd]
    k = 2.0 / (sig + 1); e = None; sigv = []
    for i, v in enumerate(mv):
        e = v if e is None else v * k + e * (1 - k)
        if i >= sig - 1: sigv.append(e)
    m2 = macd[sig - 1:]
    hist = [m2[i][1] - sigv[i] for i in range(len(sigv))]
    return macd, sigv, hist

def _ichimoku(cs, a=9, b=26, c=52):
    n = len(cs)
    def hl(i, k):
        if i - k < 0: return None
        seg = cs[i - k + 1:i + 1]
        return (max(x["h"] for x in seg) + min(x["l"] for x in seg)) / 2
    tenkan = [(i, hl(i, a)) for i in range(n) if hl(i, a)]
    kijun = [(i, hl(i, b)) for i in range(n) if hl(i, b)]
    td = dict(tenkan); kd = dict(kijun)
    senkouA = [(i, (td[i - c] + kd[i - c]) / 2) for i in range(c, n) if (i - c) in td and (i - c) in kd]
    def hhll(i, k):
        seg = cs[i - k + 1:i + 1]
        return (max(x["h"] for x in seg) + min(x["l"] for x in seg)) / 2
    senkouB = [(i, hhll(i - c, c)) for i in range(n) if i - c >= c - 1]
    chikou = [(i, cs[i + b]["c"]) for i in range(n - b)]
    return tenkan, kijun, senkouA, senkouB, chikou

def _bb(closes, n=20, k=2.0):
    """Bollinger Bands -> (upper, mid, lower) as (i, v) lists."""
    up, mid, lo = [], [], []
    for i in range(n - 1, len(closes)):
        seg = closes[i - n + 1:i + 1]
        m = sum(seg) / n
        sd = (sum((x - m) ** 2 for x in seg) / n) ** 0.5
        up.append((i, m + k * sd)); mid.append((i, m)); lo.append((i, m - k * sd))
    return up, mid, lo

def _rsi_divergences(cs, rsi):
    """Bullish: price LL + RSI HL across last two swing lows (k=3).
       Bearish: price HH + RSI LH across last two swing highs.
       Returns [(kind, price_pivot_pair, rsi_value_pair)] — most recent each."""
    out = []
    phs, pls = _pivots(cs, 3)
    def rv(i): return rsi[i] if i < len(rsi) else None
    lows = [q for q in pls if rv(q[0]) is not None]
    if len(lows) >= 2:
        a, b = lows[-2], lows[-1]
        if b[1] < a[1] and rv(b[0]) > rv(a[0]):
            out.append(("bull", (a, b), ((a[0], rv(a[0])), (b[0], rv(b[0])))))
    highs = [q for q in phs if rv(q[0]) is not None]
    if len(highs) >= 2:
        a, b = highs[-2], highs[-1]
        if b[1] > a[1] and rv(b[0]) < rv(a[0]):
            out.append(("bear", (a, b), ((a[0], rv(a[0])), (b[0], rv(b[0])))))
    return out

def _zz_pivots(cs, min_leg):
    """Alternating zigzag pivots — a pivot survives only if the swing to
    the next opposite pivot is >= min_leg (price units)."""
    phs, pls = _pivots(cs, 2)
    ev = sorted([(i, p, 'h') for i, p in phs] + [(i, p, 'l') for i, p in pls])
    zz = []
    for e in ev:
        if not zz: zz.append(e); continue
        li, lp, lt = zz[-1]
        if e[2] == lt:
            if (lt == 'h' and e[1] > lp) or (lt == 'l' and e[1] < lp):
                zz[-1] = e
        else:
            if abs(e[1] - lp) >= min_leg:
                zz.append(e)
            else:
                if (lt == 'h' and e[1] < lp - min_leg) or (lt == 'l' and e[1] > lp + min_leg):
                    zz.append(e)
    return zz

def _elliott(cs, min_leg, lbl):
    """Bounded EW: last 5 alternating legs of a zigzag satisfy impulse
    rules -> labels 1-5; a following 3-leg corrective = A-B-C.
    lbl = degree tag ('min' or 'maj')."""
    zz = _zz_pivots(cs, min_leg)
    marks = []
    if len(zz) >= 6:
        seq = zz[-7:]
        # impulse up: L0 H1 L2 H3 L4 H5 (+optional L6/H7 for ABC)
        if [e[2] for e in seq[:6]] == ['l', 'h', 'l', 'h', 'l', 'h']:
            p0, p1, p2, p3, p4, p5 = [e[1] for e in seq[:6]]
            w1, w3, w5 = p1 - p0, p3 - p2, p5 - p4
            if (p2 > p0 and p3 > p1 and p4 > p1 and p5 > p3
                    and w3 >= min(w1, w5) * 0.99 and w1 > 0 and w5 > 0):
                tags = ['0', '1', '2', '3', '4', '5']
                for e, t in zip(seq[:6], tags):
                    marks.append((e[0], e[1], t + ('*' if lbl == 'maj' else ''),
                                  '#f0b429' if lbl == 'maj' else '#c78cff',
                                  e[2] == 'h'))
                # corrective A-B-C after the 5
                if len(seq) >= 7 and seq[6][2] == 'l':
                    marks.append((seq[6][0], seq[6][1], 'A' + ('*' if lbl == 'maj' else ''), '#58d6ff', False))
        # impulse down: H0 L1 H2 L3 H4 L5
        elif [e[2] for e in seq[:6]] == ['h', 'l', 'h', 'l', 'h', 'l']:
            p0, p1, p2, p3, p4, p5 = [e[1] for e in seq[:6]]
            w1, w3, w5 = p0 - p1, p2 - p3, p4 - p5
            if (p2 < p0 and p3 < p1 and p4 < p1 and p5 < p3
                    and w3 >= min(w1, w5) * 0.99 and w1 > 0 and w5 > 0):
                tags = ['0', '1', '2', '3', '4', '5']
                for e, t in zip(seq[:6], tags):
                    marks.append((e[0], e[1], t + ('*' if lbl == 'maj' else ''),
                                  '#f0b429' if lbl == 'maj' else '#c78cff',
                                  e[2] == 'h'))
                if len(seq) >= 7 and seq[6][2] == 'h':
                    marks.append((seq[6][0], seq[6][1], 'A' + ('*' if lbl == 'maj' else ''), '#58d6ff', True))
    return marks

def _wyckoff(cs):
    """Accumulation + distribution schematic events over a 40-70 bar
    trading range. Bounded: labels only what the tape printed."""
    n = len(cs); out = []
    if n < 50: return out
    seg = cs[-60:] if n >= 60 else cs[-40:]
    o0 = n - len(seg)
    hi = max(x["h"] for x in seg); lo = min(x["l"] for x in seg)
    rng = (hi - lo) / ((hi + lo) / 2)
    if rng < 0.02 or rng > 0.12: return out
    inside = sum(1 for x in seg if lo * 0.995 <= x["c"] <= hi * 1.005)
    if inside / len(seg) < 0.8: return out
    vols = [x.get("qv", 0) or 0 for x in seg]
    vmed = sorted(vols)[len(vols) // 2] or 1
    # accumulation scan
    i_sc = min(range(len(seg)), key=lambda i: seg[i]["l"])
    if i_sc < len(seg) - 6 and seg[i_sc]["l"] <= lo * 1.005:
        out.append((o0 + i_sc, seg[i_sc]["l"], "SC"))
        i_ar = max(range(i_sc, len(seg)), key=lambda i: seg[i]["h"])
        if i_ar > i_sc: out.append((o0 + i_ar, seg[i_ar]["h"], "AR"))
        sts = [i for i in range(i_sc + 2, len(seg))
               if abs(seg[i]["l"] - seg[i_sc]["l"]) / seg[i_sc]["l"] <= 0.02
               and vols[i] < vols[i_sc]]
        if sts: out.append((o0 + sts[-1], seg[sts[-1]]["l"], "ST"))
        spr = [i for i in range(len(seg) - 15, len(seg))
               if seg[i]["l"] < lo * 0.997 and seg[i]["c"] > lo]
        if spr: out.append((o0 + spr[-1], seg[spr[-1]]["l"], "SPRING"))
        sos = [i for i in range(len(seg)) if seg[i]["c"] > hi * 1.002 and vols[i] > vmed * 1.2]
        if sos:
            out.append((o0 + sos[0], seg[sos[0]]["h"], "SOS"))
            lps = [i for i in range(sos[0], len(seg)) if seg[i]["l"] > hi * 0.995]
            if lps: out.append((o0 + lps[-1], seg[lps[-1]]["l"], "LPS"))
    # distribution mirror
    i_bc = max(range(len(seg)), key=lambda i: seg[i]["h"])
    if i_bc < len(seg) - 6 and seg[i_bc]["h"] >= hi * 0.995:
        out.append((o0 + i_bc, seg[i_bc]["h"], "BC"))
        sow = [i for i in range(len(seg)) if seg[i]["c"] < lo * 0.998]
        if sow: out.append((o0 + sow[0], seg[sow[0]]["l"], "SOW"))
    return out

def _market_structure(cs, min_leg):
    """HH/HL/LH/LL labels from zigzag pivots — compare consecutive
    same-type pivots (Dow theory swing classification)."""
    zz = _zz_pivots(cs, min_leg)
    marks = []
    prev = {}
    for i, p, t in zz:
        if t in prev:
            pi, pp = prev[t]
            lbl = ("HH" if p > pp else "LH") if t == "h" else ("HL" if p > pp else "LL")
            marks.append((i, p, lbl))
        prev[t] = (i, p)
    return marks

def _obv(cs):
    """On-Balance Volume — cumulative signed volume (Dow theory proxy:
    volume confirms the trend when OBV makes the same HH/HL structure)."""
    out = []; v = 0.0
    for i, c in enumerate(cs):
        if i:
            qv = c.get("qv", 0) or 0
            if c["c"] > cs[i - 1]["c"]: v += qv
            elif c["c"] < cs[i - 1]["c"]: v -= qv
        out.append((i, v))
    return out

def _obv_divergence(cs, obv, k=3):
    """(kind, ...) — bear: price HH + OBV LH (distribution);
    bull: price LL + OBV HL (accumulation under weakness)."""
    phs, pls = _pivots(cs, k)
    od = dict(obv)
    highs = [q for q in phs if q[0] in od]
    if len(highs) >= 2:
        a, b = highs[-2], highs[-1]
        if b[1] > a[1] and od[b[0]] < od[a[0]]: return "bear", (a, b)
    lows = [q for q in pls if q[0] in od]
    if len(lows) >= 2:
        a, b = lows[-2], lows[-1]
        if b[1] < a[1] and od[b[0]] > od[a[0]]: return "bull", (a, b)
    return None, None

def _tv_series(cs, idx_vals):
    return [{"time": cs[i]["t"] // 1000, "value": round(v, 10)} for i, v in idx_vals
            if 0 <= i < len(cs) and v is not None]

def render_structure_tv(sym, side, entry, sl, tps, out_png, gran="15m",
                        break_px=None, stage=None, title=None, stats=None,
                        anchors=None, pattern=None):
    """Full-stack TradingView card. Returns True on success; caller falls
    back to the Pillow renderer on False."""
    try:
        cs = candles(sym, gran, 160)
        n = len(cs)
        if n < 60: return False
        last_px = cs[-1]["c"]
        closes = [c["c"] for c in cs]
        atr = sum(c["h"] - c["l"] for c in cs[-32:]) / min(32, n)
        ts2i = {c["t"]: i for i, c in enumerate(cs)}
        lc = []
        for c in cs:
            lc.append({"time": c["t"] // 1000, "open": c["o"], "high": c["h"],
                       "low": c["l"], "close": c["c"], "volume": c.get("qv", 0) or 0})
        # --- lines: anchored TLs projected bar-by-bar; neckline ---
        lines = []
        def tl_series(pts, color, dash=False):
            if not pts or len(pts) < 2: return
            i0, i1 = ts2i.get(pts[0][0]), ts2i.get(pts[1][0])
            if i0 is None or i1 is None or i1 == i0: return
            m = (pts[1][1] - pts[0][1]) / (i1 - i0)
            b = pts[0][1] - m * i0
            data = [{"time": cs[k]["t"] // 1000, "value": m * k + b}
                    for k in range(max(0, i0), n)]
            lines.append({"data": data, "color": color, "dash": dash})
        marks = []
        if anchors:
            tl_series(anchors.get("upPts"), "#58d6ff")
            tl_series(anchors.get("loPts"), "#c78cff")
            for t, pp, lbl in anchors.get("marks") or []:
                i = ts2i.get(t)
                if i is not None:
                    marks.append({"t": cs[i]["t"] // 1000, "label": lbl,
                                  "color": "#c78cff", "above": False})
            if anchors.get("neckline"):
                nk = anchors["neckline"]
                lines.append({"data": [{"time": lc[0]["time"], "value": nk},
                                       {"time": lc[-1]["time"], "value": nk}],
                              "color": "#c78cff", "dash": True})
        # --- indicators ---
        rsi = _rsi(closes)
        rsi_ser = [{"time": cs[i]["t"] // 1000, "value": rsi[i]}
                   for i in range(n) if i < len(rsi) and rsi[i] is not None]
        m_line, m_sig, m_hist = _macd(closes)
        macd_ser = {
            "macd": [{"time": cs[i]["t"] // 1000, "value": v} for i, v in m_line],
            "signal": [{"time": cs[i]["t"] // 1000, "value": v} for i, v in zip([x[0] for x in m_line[-len(m_sig):]] if m_sig else [], m_sig)],
            "hist": [{"time": cs[i + (n - len(m_hist))]["t"] // 1000, "value": v}
                     for i, v in enumerate(m_hist)],
        }
        _bbu, _bbm, _bbl = _bb(closes)
        _bb_spec = {"up": _tv_series(cs, _bbu), "mid": _tv_series(cs, _bbm),
                    "lo": _tv_series(cs, _bbl)}
        tenkan, kijun, sa, sb, chik = _ichimoku(cs)
        ichi = {"tenkan": _tv_series(cs, tenkan), "kijun": _tv_series(cs, kijun),
                "senkouA": _tv_series(cs, sa), "senkouB": _tv_series(cs, sb),
                "chikou": _tv_series(cs, chik)}
        # --- divergences: price-line + rsi-line pairs ---
        rsi_lines = []
        for kind, (pa, pb), (ra, rb) in _rsi_divergences(cs, rsi):
            col = "#26a65b" if kind == "bull" else "#e74c3c"
            lines.append({"data": [{"time": cs[pa[0]]["t"] // 1000, "value": pa[1]},
                                   {"time": cs[pb[0]]["t"] // 1000, "value": pb[1]}],
                          "color": col, "w": 2})
            rsi_lines.append({"data": [{"time": cs[ra[0]]["t"] // 1000, "value": ra[1]},
                                       {"time": cs[rb[0]]["t"] // 1000, "value": rb[1]}],
                              "color": col})
            marks.append({"t": cs[pb[0]]["t"] // 1000,
                          "label": "DIV+" if kind == "bull" else "DIV-",
                          "color": col, "above": kind == "bear"})
        # --- Elliott Wave, minor + major degree ---
        for i, pp, lbl, col, abv in _elliott(cs, max(atr * 1.2, last_px * 0.01), 'min'):
            marks.append({"t": cs[i]["t"] // 1000, "label": lbl, "color": col, "above": abv})
        for i, pp, lbl, col, abv in _elliott(cs, max(atr * 2.2, last_px * 0.02), 'maj'):
            marks.append({"t": cs[i]["t"] // 1000, "label": lbl, "color": col, "above": abv})
        # --- market structure: HH/HL/LH/LL swing classification ---
        _ms_col = {"HH": "#26a65b", "HL": "#58d6ff", "LH": "#f0b429", "LL": "#e74c3c"}
        for i, pp, lbl in _market_structure(cs, max(atr * 0.9, last_px * 0.005)):
            marks.append({"t": cs[i]["t"] // 1000, "label": lbl,
                          "color": _ms_col[lbl], "above": lbl in ("HH", "LH"),
                          "shape": "square"})
        # --- OBV divergence marker on price ---
        _obv_ser = _obv(cs)
        _obv_kind, _obv_pair = _obv_divergence(cs, _obv_ser)
        if _obv_kind and _obv_pair:
            marks.append({"t": cs[_obv_pair[1][0]]["t"] // 1000,
                          "label": "OBV-" if _obv_kind == "bear" else "OBV+",
                          "color": "#e74c3c" if _obv_kind == "bear" else "#26a65b",
                          "above": _obv_kind == "bear", "shape": "circle"})
        # --- Wyckoff events ---
        for i, pp, lbl in _wyckoff(cs):
            marks.append({"t": cs[i]["t"] // 1000, "label": lbl,
                          "color": "#f0b429", "above": pp > cs[i]["c"], "shape": "square"})
        # --- break / retest markers ---
        sgn = 1 if (side or "long").lower() == "long" else -1
        brk_t = ret_t = None
        if break_px:
            for i in range(n - 1, max(0, n - 60), -1):
                c = cs[i]
                if sgn > 0 and c["c"] >= break_px: brk_t = i
                if sgn < 0 and c["c"] <= break_px: brk_t = i
            if brk_t is not None:
                for j in range(brk_t + 1, n):
                    c = cs[j]
                    if entry and ((sgn > 0 and c["l"] <= entry * 1.001) or
                                  (sgn < 0 and c["h"] >= entry * 0.999)):
                        ret_t = j; break
        spec = {
            "sym": sym, "title": title or ("%s %s — %s" % (side.upper(), sym, stage or "structure")),
            "stats": stats, "pattern": pattern or (anchors or {}).get("pattern"),
            "candles": lc,
            "ema20": _tv_series(cs, _ema_series(closes, 20)),
            "ema50": _tv_series(cs, _ema_series(closes, 50)),
            "rsi": rsi_ser, "rsiLines": rsi_lines,
            "macd": macd_ser, "ichi": ichi, "obv": _tv_series(cs, _obv_ser),
            "bb": _bb_spec,
            "lines": lines, "marks": marks,
            "levels": {"breakPx": break_px, "entryPx": entry, "slPx": sl,
                       "tps": [t for t in (tps or []) if t]},
            "breakT": lc[brk_t]["time"] if brk_t is not None else None,
            "retestT": lc[ret_t]["time"] if ret_t is not None else None,
            "out": out_png, "w": 1100, "h": 780,
        }
        sp = "/tmp/tv-spec-%s.json" % sym
        with open(sp, "w") as f:
            _json.dump(spec, f)
        r = _sp.run(["node", TV_RENDER_JS, sp], capture_output=True, timeout=90,
                    text=True)
        if r.returncode == 0 and _os.path.exists(out_png):
            return True
        _os.environ.setdefault("TV_RENDER_ERR", (r.stderr or r.stdout or '')[-300:])
        return False
    except Exception:
        return False
