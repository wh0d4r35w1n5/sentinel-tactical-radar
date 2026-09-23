// TA engine — key levels + SFP (primary), ICT FVGs, Elliott W5 (Philakone
// short-the-top), Wyckoff springs/upthrusts, candlestick patterns, fib
// confluence, market structure, momentum ignition.
// UMD: browser global `TAEngine`, Node CJS require/import.
(function (g) {
  'use strict';
  var H = g.Harmonics || (typeof require === 'function' ? require('./harmonics.js') : null);
  var zigzag = H && H.zigzag;

  // ---------- key levels + SFP ----------
  function keyLevels(cs, dev) {
    var piv = zigzag(cs, dev || 0.015);
    var highs = piv.filter(function (p) { return p.type === 'H'; }).map(function (p) { return p.p; });
    var lows = piv.filter(function (p) { return p.type === 'L'; }).map(function (p) { return p.p; });
    return { highs: highs, lows: lows, pivots: piv };
  }

  // Swing-failure pattern: wick sweeps a prior key level, body closes back inside.
  function sfp(cs, lookback) {
    var lv = keyLevels(cs);
    var n = cs.length, out = [];
    for (var i = Math.max(2, n - (lookback || 8)); i < n; i++) {
      var c = cs[i];
      for (var j = 0; j < lv.highs.length; j++) {
        var h = lv.highs[j];
        if (h <= c.c && h <= c.o) continue;                 // level must be above body
        if (c.h > h * 1.001 && Math.max(c.o, c.c) < h) {    // swept high, closed under
          var strength = Math.min(100, Math.round(((c.h - Math.max(c.o, c.c)) / (c.h - c.l || 1)) * 100) + 20);
          out.push({ type: 'bearish', level: h, sweep: c.h, closeBack: c.c, i: i, age: n - 1 - i, strength: strength });
        }
      }
      for (var k = 0; k < lv.lows.length; k++) {
        var l = lv.lows[k];
        if (l >= c.c && l >= c.o) continue;
        if (c.l < l * 0.999 && Math.min(c.o, c.c) > l) {    // swept low, closed over
          var st = Math.min(100, Math.round(((Math.min(c.o, c.c) - c.l) / (c.h - c.l || 1)) * 100) + 20);
          out.push({ type: 'bullish', level: l, sweep: c.l, closeBack: c.c, i: i, age: n - 1 - i, strength: st });
        }
      }
    }
    out.sort(function (a, b) { return a.age - b.age || b.strength - a.strength; });
    return out[0] || null;
  }

  // ---------- ICT fair value gaps ----------
  function fvgs(cs, tail) {
    var out = [], n = cs.length;
    for (var i = Math.max(2, n - (tail || 40)); i < n; i++) {
      var a = cs[i - 2], c = cs[i];
      if (c.l > a.h) { // bullish gap: c1 high -> c3 low
        var filled = false;
        for (var j = i + 1; j < n; j++) if (cs[j].l <= a.h) { filled = true; break; }
        out.push({ type: 'bullish', top: c.l, bot: a.h, i: i, filled: filled, age: n - 1 - i });
      }
      if (c.h < a.l) { // bearish gap: c1 low -> c3 high
        var f2 = false;
        for (var j2 = i + 1; j2 < n; j2++) if (cs[j2].h >= a.l) { f2 = true; break; }
        out.push({ type: 'bearish', top: a.l, bot: c.h, i: i, filled: f2, age: n - 1 - i });
      }
    }
    return out.filter(function (f) { return !f.filled; })
      .sort(function (a, b) { return a.age - b.age; });
  }

  // ---------- Elliott 5-wave impulse -> Philakone W5-top short ----------
  function elliott(cs) {
    var piv = zigzag(cs, 0.02);
    var out = [];
    for (var w = 0; w + 6 <= piv.length; w++) {
      var p = piv.slice(w, w + 6);
      var seq = p.map(function (x) { return x.type; }).join('');
      var up = seq === 'LHLHLH';   // impulse up: ends at wave-5 HIGH -> short setup
      var dn = seq === 'HLHLHL';   // impulse down: ends at wave-5 LOW -> long setup
      if (!up && !dn) continue;
      var X = p[0].p, W1 = p[1].p, W2 = p[2].p, W3 = p[3].p, W4 = p[4].p, W5 = p[5].p;
      var w1 = Math.abs(W1 - X), w2r = Math.abs(W1 - W2) / (w1 || 1),
          w3 = Math.abs(W3 - W2), w4r = Math.abs(W3 - W4) / (w3 || 1),
          w5 = Math.abs(W5 - W4), w13 = Math.abs(W3 - X);
      var ok;
      if (up) ok = W2 > X * 0.995 && W4 > W1 * 0.99 && // W2 holds, W4 no overlap
                 w3 >= w1 * 0.95 && w3 >= w5 * 0.95 && // W3 not shortest
                 w2r > 0.236 && w2r < 0.9 && w4r > 0.1 && w4r < 0.62 &&
                 w5 > w13 * 0.2 && w5 < w13 * 1.05;
      else   ok = W2 < X * 1.005 && W4 < W1 * 1.01 &&
                 w3 >= w1 * 0.95 && w3 >= w5 * 0.95 &&
                 w2r > 0.236 && w2r < 0.9 && w4r > 0.1 && w4r < 0.62 &&
                 w5 > w13 * 0.2 && w5 < w13 * 1.05;
      if (!ok) continue;
      var q = Math.round(100 - (Math.abs(w2r - 0.5) + Math.abs(w4r - 0.382) +
        Math.abs(w5 / (w13 || 1) - 0.618)) * 60);
      out.push({ complete: true, dir: up ? 'up' : 'down',
        shortTop: up, longBottom: dn,
        points: p, quality: Math.max(0, Math.min(100, q)),
        ratios: { w2r: +w2r.toFixed(3), w4r: +w4r.toFixed(3), w5w13: +(w5 / (w13 || 1)).toFixed(3) },
        dIdx: p[5].i, dPrice: W5 });
    }
    out.sort(function (a, b) { return b.dIdx - a.dIdx || b.quality - a.quality; });
    var recent = out.find(function (o) { return cs.length - 1 - o.dIdx <= 10; });
    return recent || out[0] || null;
  }

  // ---------- Wyckoff range: spring / upthrust ----------
  function wyckoff(cs, lookback) {
    var n = cs.length, win = Math.min(lookback || 30, n - 5);
    if (win < 10) return null;
    var base = cs.slice(n - win - 5, n - 5);
    var hi = Math.max.apply(null, base.map(function (c) { return c.h; }));
    var lo = Math.min.apply(null, base.map(function (c) { return c.l; }));
    var rng = hi - lo; if (rng <= 0) return null;
    var avgV = base.reduce(function (a, c) { return a + (c.qv || 0); }, 0) / base.length;
    for (var i = n - 5; i < n; i++) {
      var c = cs[i], vol = avgV ? (c.qv || 0) / avgV : 1;
      if (c.l < lo - rng * 0.02 && c.c > lo && vol > 1.1)
        return { phase: 'accumulation', event: 'spring', level: lo, volX: +vol.toFixed(2), age: n - 1 - i, bias: 'LONG' };
      if (c.h > hi + rng * 0.02 && c.c < hi && vol > 1.1)
        return { phase: 'distribution', event: 'upthrust', level: hi, volX: +vol.toFixed(2), age: n - 1 - i, bias: 'SHORT' };
    }
    return { phase: 'range', hi: hi, lo: lo, bias: null };
  }

  // ---------- candlestick patterns (last 3 candles) ----------
  function candlesticks(cs) {
    var out = [], n = cs.length;
    if (n < 3) return out;
    var c = cs[n - 1], p = cs[n - 2], pp = cs[n - 3];
    var body = Math.abs(c.c - c.o), rng = c.h - c.l || 1e-12;
    var uw = c.h - Math.max(c.o, c.c), lw = Math.min(c.o, c.c) - c.l;
    var pbody = Math.abs(p.c - p.o);
    if (c.c > c.o && p.c < p.o && c.c >= p.o && c.o <= p.c && body > pbody) out.push('bullish engulfing');
    if (c.c < c.o && p.c > p.o && c.c <= p.o && c.o >= p.c && body > pbody) out.push('bearish engulfing');
    if (lw > body * 2 && uw < body) out.push('hammer');
    if (uw > body * 2 && lw < body) out.push('shooting star');
    if (body / rng < 0.1) out.push('doji');
    if (body / rng > 0.9) out.push(c.c > c.o ? 'bullish marubozu' : 'bearish marubozu');
    if (pp.c < pp.o && Math.abs(p.c - p.o) < Math.abs(pp.c - pp.o) * 0.4 && c.c > c.o && c.c > (pp.o + pp.c) / 2) out.push('morning star');
    if (pp.c > pp.o && Math.abs(p.c - p.o) < Math.abs(pp.c - pp.o) * 0.4 && c.c < c.o && c.c < (pp.o + pp.c) / 2) out.push('evening star');
    return out;
  }

  // ---------- fib confluence / golden pocket ----------
  function fib(cs) {
    var piv = zigzag(cs, 0.025);
    if (piv.length < 3) return null;
    var last = cs[cs.length - 1].c;
    var swings = [];
    for (var i = Math.max(0, piv.length - 4); i < piv.length - 1; i++)
      swings.push({ a: piv[i], b: piv[i + 1] });
    var levels = [];
    swings.forEach(function (s) {
      [0.382, 0.5, 0.618, 0.65, 0.786].forEach(function (f) {
        levels.push(s.b.p - (s.b.p - s.a.p) * f);
      });
    });
    var clusters = 0;
    for (var i2 = 0; i2 < levels.length; i2++)
      for (var j2 = i2 + 1; j2 < levels.length; j2++)
        if (Math.abs(levels[i2] - levels[j2]) / last < 0.005) clusters++;
    var dom = swings[swings.length - 1];
    var gpLo = dom.b.p - (dom.b.p - dom.a.p) * 0.66, gpHi = dom.b.p - (dom.b.p - dom.a.p) * 0.618;
    var inGP = last >= Math.min(gpLo, gpHi) && last <= Math.max(gpLo, gpHi);
    return { clusters: clusters, goldenPocket: inGP,
      zone: [Math.min(gpLo, gpHi), Math.max(gpLo, gpHi)] };
  }

  // ---------- structure: HH/HL vs LH/LL ----------
  function structure(cs) {
    var piv = zigzag(cs, 0.02);
    var hh = 0, hl = 0, lh = 0, ll = 0;
    var hs = piv.filter(function (p) { return p.type === 'H'; });
    var ls = piv.filter(function (p) { return p.type === 'L'; });
    for (var i = 1; i < hs.length; i++) hs[i].p > hs[i - 1].p ? hh++ : lh++;
    for (var j = 1; j < ls.length; j++) ls[j].p > ls[j - 1].p ? hl++ : ll++;
    var trend = hh + hl > lh + ll ? 'up' : hh + hl < lh + ll ? 'down' : 'range';
    return { hh: hh, hl: hl, lh: lh, ll: ll, trend: trend };
  }

  // ---------- momentum ignition (last candle expansion) ----------
  function ignition(cs) {
    var n = cs.length; if (n < 12) return null;
    var ranges = cs.slice(-12, -1).map(function (c) { return c.h - c.l; });
    var med = ranges.sort(function (a, b) { return a - b; })[Math.floor(ranges.length / 2)] || 1e-12;
    var c = cs[n - 1], vr = (c.h - c.l) / med;
    var avgV = cs.slice(-12, -1).reduce(function (a, x) { return a + (x.qv || 0); }, 0) / 11 || 1;
    var volX = (c.qv || 0) / avgV;
    if (vr > 1.8 && volX > 1.5)
      return { rangeX: +vr.toFixed(2), volX: +volX.toFixed(2), dir: c.c >= c.o ? 'LONG' : 'SHORT' };
    return null;
  }

  // ---------- Lepus/Jackson: session VWAP mean reversion ----------
  // "price always returns to VWAP" — stretched deviations are fade candidates.
  function vwap(cs, win) {
    var n = cs.length, w = Math.min(win || 24, n);
    if (w < 8) return null;
    var pv = 0, vv = 0, series = [];
    for (var i = n - w; i < n; i++) {
      var c = cs[i], tp = (c.h + c.l + c.c) / 3, v = c.qv || 1;
      pv += tp * v; vv += v;
      series.push({ t: c.t, v: pv / vv });
    }
    var vw = pv / vv;
    var devs = series.map(function (s, i2) { return cs[n - w + i2].c - s.v; });
    var sd = Math.sqrt(devs.reduce(function (a, x) { return a + x * x; }, 0) / devs.length) || 1e-12;
    var last = cs[n - 1].c, z = (last - vw) / sd, devPct = (last - vw) / vw * 100;
    return {
      vwap: vw, z: +z.toFixed(2), devPct: +devPct.toFixed(2),
      stretched: Math.abs(z) > 1.5,
      fade: z > 1.5 ? 'SHORT' : z < -1.5 ? 'LONG' : null, // reversion bias
      series: series,
    };
  }

  // ---------- composite ----------
  function analyze(cs, cs5m) {
    if (!cs || cs.length < 20 || !zigzag) return null;
    var s = sfp(cs), f = fvgs(cs), e = elliott(cs), w = wyckoff(cs),
        cd = candlesticks(cs), fb = fib(cs), st = structure(cs), ig = ignition(cs),
        vw = vwap(cs5m && cs5m.length >= 24 ? cs5m : cs, cs5m && cs5m.length >= 24 ? 288 : 24);
    // bias: SFP leads, then completed W5, then wyckoff event, then ignition
    var bias = null, reasons = [];
    if (s) { bias = s.type === 'bullish' ? 'LONG' : 'SHORT'; reasons.push('sfp'); }
    else if (e && e.complete && cs.length - 1 - e.dIdx <= 10) {
      bias = e.shortTop ? 'SHORT' : 'LONG'; reasons.push('elliott-w5');
    } else if (w && w.event) { bias = w.bias; reasons.push('wyckoff-' + w.event); }
    else if (ig) { bias = ig.dir; reasons.push('ignition'); }
    else if (vw && vw.stretched) { bias = vw.fade; reasons.push('vwap-reversion'); }
    var confluence = 0;
    if (bias) {
      if (s && (s.type === 'bullish') === (bias === 'LONG')) confluence++;
      if (e && ((e.shortTop && bias === 'SHORT') || (e.longBottom && bias === 'LONG'))) confluence++;
      if (w && w.bias === bias) confluence++;
      if (ig && ig.dir === bias) confluence++;
      if (vw && vw.fade === bias) confluence++;
      if (st.trend === (bias === 'LONG' ? 'up' : 'down')) confluence++;
      if (fb && fb.goldenPocket) confluence++;
      if (cd.some(function (x) { return (x.indexOf('bull') === 0 || x === 'hammer' || x === 'morning star') === (bias === 'LONG'); })) confluence++;
    }
    return { sfp: s, fvgs: f.slice(0, 4), elliott: e, wyckoff: w,
             candles: cd, fib: fb, structure: st, ignition: ig, vwap: vw,
             bias: bias, reasons: reasons, confluence: confluence };
  }

  g.TAEngine = { analyze: analyze, sfp: sfp, fvgs: fvgs, elliott: elliott,
                 wyckoff: wyckoff, candlesticks: candlesticks, fib: fib,
                 structure: structure, ignition: ignition, keyLevels: keyLevels,
                 vwap: vwap };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.TAEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
