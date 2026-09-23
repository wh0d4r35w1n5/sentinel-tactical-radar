// Harmonic pattern detection — Gartley + Bat, XABCD via zigzag pivots.
// UMD: browser global `Harmonics`, Node CJS require/import.
(function (g) {
  'use strict';

  // Alternating pivot highs/lows from candles {t,h,l,c} using a % reversal dev.
  function zigzag(cs, dev) {
    dev = dev || 0.02;
    if (!cs || cs.length < 5) return [];
    var piv = [];
    var dir = 0; // 1 up leg, -1 down leg
    var hi = cs[0].h, hiI = 0, lo = cs[0].l, loI = 0;
    for (var i = 1; i < cs.length; i++) {
      if (dir >= 0) {
        if (cs[i].h > hi) { hi = cs[i].h; hiI = i; }
        else if (cs[i].l < hi * (1 - dev)) {
          piv.push({ i: hiI, t: cs[hiI].t, type: 'H', p: hi });
          dir = -1; lo = cs[i].l; loI = i;
        }
      }
      if (dir <= 0) {
        if (cs[i].l < lo) { lo = cs[i].l; loI = i; }
        else if (cs[i].h > lo * (1 + dev)) {
          piv.push({ i: loI, t: cs[loI].t, type: 'L', p: lo });
          dir = 1; hi = cs[i].h; hiI = i;
        }
      }
    }
    piv.push({ i: dir >= 0 ? hiI : loI, t: cs[dir >= 0 ? hiI : loI].t,
      type: dir >= 0 ? 'H' : 'L', p: dir >= 0 ? hi : lo });
    return piv;
  }

  var PATTERNS = {
    Gartley: {
      abXa: [0.567, 0.669],      // 0.618 ± ~8%
      bcAb: [0.34, 0.95],        // 0.382–0.886 with slack
      cdBc: [1.13, 1.78],        // 1.272–1.618 with slack
      adXa: [0.73, 0.84],        // 0.786
      ideal: { abXa: 0.618, bcAb: 0.618, cdBc: 1.272, adXa: 0.786 },
    },
    Bat: {
      abXa: [0.34, 0.55],        // 0.382–0.50
      bcAb: [0.34, 0.95],
      cdBc: [1.44, 2.85],        // 1.618–2.618
      adXa: [0.83, 0.94],        // 0.886
      ideal: { abXa: 0.382, bcAb: 0.618, cdBc: 2.0, adXa: 0.886 },
    },
    Butterfly: {
      abXa: [0.73, 0.84],        // 0.786
      bcAb: [0.34, 0.95],
      cdBc: [1.44, 2.42],        // 1.618–2.24
      adXa: [1.18, 1.38],        // 1.27 extension beyond X
      ideal: { abXa: 0.786, bcAb: 0.618, cdBc: 1.618, adXa: 1.272 },
    },
    Crab: {
      abXa: [0.34, 0.669],
      bcAb: [0.34, 0.95],
      cdBc: [2.42, 3.85],        // 2.618–3.618
      adXa: [1.5, 1.75],         // 1.618 deep extension
      ideal: { abXa: 0.5, bcAb: 0.618, cdBc: 3.14, adXa: 1.618 },
    },
  };

  function ratios(pts) {
    var X = pts[0], A = pts[1], B = pts[2], C = pts[3], D = pts[4];
    var XA = Math.abs(A.p - X.p), AB = Math.abs(B.p - A.p),
        BC = Math.abs(C.p - B.p), CD = Math.abs(D.p - C.p);
    if (!XA || !AB || !BC) return null;
    // AD/XA = share of the XA leg retraced at D (signed form works both dirs)
    var adXa = (A.p - D.p) / (A.p - X.p);
    return { abXa: AB / XA, bcAb: BC / AB, cdBc: CD / BC, adXa: adXa };
  }

  function inBand(v, band) { return v >= band[0] && v <= band[1]; }

  // Scan all consecutive 5-pivot windows; return patterns sorted by quality.
  function detect(cs, opts) {
    opts = opts || {};
    var piv = zigzag(cs, opts.dev || 0.015);
    var out = [];
    for (var w = 0; w + 5 <= piv.length; w++) {
      var pts = piv.slice(w, w + 5);
      var seq = pts.map(function (p) { return p.type; }).join('');
      if (seq !== 'LHLHL' && seq !== 'HLHLH') continue;
      var r = ratios(pts);
      if (!r) continue;
      var bullish = seq === 'LHLHL'; // X low -> D completes low (buy zone)
      for (var name in PATTERNS) {
        var P = PATTERNS[name];
        if (!inBand(r.abXa, P.abXa) || !inBand(r.bcAb, P.bcAb) ||
            !inBand(r.cdBc, P.cdBc) || !inBand(r.adXa, P.adXa)) continue;
        var err = 0;
        for (var k in P.ideal) err += Math.abs(r[k] - P.ideal[k]);
        out.push({
          type: name,
          dir: bullish ? 'bullish' : 'bearish',
          points: pts,
          ratios: {
            abXa: +r.abXa.toFixed(3), bcAb: +r.bcAb.toFixed(3),
            cdBc: +r.cdBc.toFixed(3), adXa: +r.adXa.toFixed(3),
          },
          quality: Math.max(0, Math.round(100 - err * 45)),
          dIdx: pts[4].i,
          dPrice: pts[4].p,
        });
      }
    }
    out.sort(function (a, b) { return b.quality - a.quality || b.dIdx - a.dIdx; });
    return out;
  }

  // Best pattern whose D (completion) is within `recent` candles of the end.
  function active(cs, recent, opts) {
    var pats = detect(cs, opts);
    var n = cs.length;
    for (var i = 0; i < pats.length; i++) {
      if (n - 1 - pats[i].dIdx <= (recent || 8)) return pats[i];
    }
    return null;
  }

  g.Harmonics = { zigzag: zigzag, detect: detect, active: active, PATTERNS: PATTERNS };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.Harmonics;
})(typeof globalThis !== 'undefined' ? globalThis : this);
