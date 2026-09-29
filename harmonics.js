// Harmonic pattern detection — full Carney XABCD set (Gartley, Bat,
// Alt-Bat, Butterfly, Crab, Deep Crab, Shark, Cypher) + AB=CD + 5-0,
// via zigzag pivots. Ratio bands from the canonical spec
// (neurotrader888/TechnicalAnalysisAutomation — the reference table
// most GitHub implementations cite) with log-space error scoring.
// Adds the PRZ projector: given a formed XABC, compute the Potential
// Reversal Zone where D must land for each pattern — forward-looking
// confluence before the pattern completes, not just history tagging.
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

  // Carney ratio spec — each leg band [min,max] + ideal for error scoring.
  // Bands carry ~6-8% slack around the book ratios (pivots are noisy);
  // the ideal anchors the quality score, not the gate.
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
    AltBat: {
      abXa: [0.34, 0.44],        // 0.382 shallow B
      bcAb: [0.34, 0.95],
      cdBc: [1.8, 3.9],          // 2.0–3.618 extreme CD
      adXa: [1.05, 1.22],        // 1.13 extension beyond X
      ideal: { abXa: 0.382, bcAb: 0.618, cdBc: 2.618, adXa: 1.13 },
    },
    Butterfly: {
      abXa: [0.73, 0.84],        // 0.786
      bcAb: [0.34, 0.95],
      cdBc: [1.44, 2.42],        // 1.618–2.24
      adXa: [1.18, 1.38],        // 1.272–1.41 extension beyond X
      ideal: { abXa: 0.786, bcAb: 0.618, cdBc: 1.618, adXa: 1.272 },
    },
    Crab: {
      abXa: [0.34, 0.669],
      bcAb: [0.34, 0.95],
      cdBc: [2.42, 3.85],        // 2.618–3.618
      adXa: [1.5, 1.75],         // 1.618 deep extension
      ideal: { abXa: 0.5, bcAb: 0.618, cdBc: 3.14, adXa: 1.618 },
    },
    DeepCrab: {
      abXa: [0.83, 0.94],        // 0.886 deep B
      bcAb: [0.34, 0.95],
      cdBc: [1.8, 3.9],          // 2.0–3.618
      adXa: [1.5, 1.75],         // 1.618
      ideal: { abXa: 0.886, bcAb: 0.5, cdBc: 2.618, adXa: 1.618 },
    },
    Shark: {
      abXa: null,                // no XA-B requirement (0.886–1.13 is on adXa/xcCd)
      bcAb: [1.05, 1.75],        // 1.13–1.618: B extends PAST A
      cdBc: [1.44, 2.42],        // 1.618–2.24
      adXa: [0.82, 1.22],        // 0.886–1.13 of XA (near-X completion)
      ideal: { bcAb: 1.27, cdBc: 1.886, adXa: 1.0 },
    },
    Cypher: {
      abXa: [0.34, 0.669],       // 0.382–0.618
      bcAb: [1.05, 1.5],         // 1.13–1.414: B extends past A
      cdBc: [1.13, 2.15],        // 1.272–2.0
      adXa: [0.73, 0.84],        // 0.786 retracement of XC (approx via adXa)
      ideal: { abXa: 0.5, bcAb: 1.272, cdBc: 1.618, adXa: 0.786 },
    },
    ABCD: {
      abXa: null, bcAb: [0.34, 0.95], cdBc: null,
      adXa: null,
      abcdEq: [0.9, 1.12],       // CD ≈ AB in length — the defining constraint
      ideal: { bcAb: 0.618 },
    },
    FiveZero: {
      abXa: [1.05, 1.75],        // 1.13–1.618: B blows past X's leg measure
      bcAb: [1.44, 2.42],        // 1.618–2.24
      cdBc: [0.42, 0.58],        // D retraces exactly ~50% of BC
      adXa: null,
      ideal: { abXa: 1.272, bcAb: 1.886, cdBc: 0.5 },
    },
  };

  function ratios(pts) {
    var X = pts[0], A = pts[1], B = pts[2], C = pts[3], D = pts[4];
    var XA = Math.abs(A.p - X.p), AB = Math.abs(B.p - A.p),
        BC = Math.abs(C.p - B.p), CD = Math.abs(D.p - C.p);
    if (!XA || !AB || !BC) return null;
    // AD/XA = share of the XA leg retraced at D (signed form works both dirs)
    var adXa = (A.p - D.p) / (A.p - X.p);
    return { abXa: AB / XA, bcAb: BC / AB, cdBc: CD / BC, adXa: adXa,
             abcdEq: CD / AB };
  }

  function inBand(v, band) { return band != null && v >= band[0] && v <= band[1]; }
  function noBand(band) { return band == null; }

  // log-space error — Carney ratios live in multiplicative space; a 0.1 miss
  // at 0.38 is far worse than 0.1 at 3.6. (neurotrader888's get_error)
  function logErr(actual, spec) {
    if (spec == null) return 0;
    var la = Math.log(actual || 1e-9);
    if (Array.isArray(spec)) {
      var l0 = Math.log(spec[0]), l1 = Math.log(spec[1]);
      if (la >= l0 && la <= l1) return 0;
      return Math.min(Math.abs(la - l0), Math.abs(la - l1)) * 2;
    }
    return Math.abs(la - Math.log(spec));
  }

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
        if (!(noBand(P.abXa) || inBand(r.abXa, P.abXa))) continue;
        if (!(noBand(P.bcAb) || inBand(r.bcAb, P.bcAb))) continue;
        if (!(noBand(P.cdBc) || inBand(r.cdBc, P.cdBc))) continue;
        if (!(noBand(P.adXa) || inBand(r.adXa, P.adXa))) continue;
        if (!(noBand(P.abcdEq) || inBand(r.abcdEq, P.abcdEq))) continue;
        // log-space error across the spec's ideal ratios
        var err = 0;
        for (var k in P.ideal) {
          var av = r[k];
          if (av != null) err += logErr(av, P.ideal[k]);
        }
        var dIdx = pts[4].i;
        out.push({
          type: name,
          dir: bullish ? 'bullish' : 'bearish',
          points: pts,
          ratios: {
            abXa: +r.abXa.toFixed(3), bcAb: +r.bcAb.toFixed(3),
            cdBc: r.cdBc != null ? +r.cdBc.toFixed(3) : null,
            adXa: r.adXa != null ? +r.adXa.toFixed(3) : null,
          },
          // PRZ: the D completion band — for reversals the trade zone,
          // scored tight when XAD and BCD agree where D lands
          prz: przOf(pts, P, bullish),
          quality: Math.max(0, Math.round(100 - err * 45)),
          dIdx: dIdx,
          dPrice: pts[4].p,
        });
      }
    }
    out.sort(function (a, b) { return b.quality - a.quality || b.dIdx - a.dIdx; });
    return out;
  }

  // PRZ band for a completed pattern — the tight zone between the XAD and
  // BCD projections that both insist on. For live trading this is where
  // the reversal was *supposed* to happen — also used by project().
  function przOf(pts, P, bullish) {
    var X = pts[0], A = pts[1], B = pts[2], C = pts[3];
    var XA = Math.abs(A.p - X.p), BC = Math.abs(C.p - B.p);
    if (!XA || !BC) return null;
    var dirn = bullish ? -1 : 1; // bullish D sits BELOW C (buy zone)
    var lo = Infinity, hi = -Infinity;
    // XAD projection: A ± adXa×XA
    if (P.adXa) {
      var d1 = bullish ? A.p - XA * P.adXa[0] : A.p + XA * P.adXa[0];
      var d2 = bullish ? A.p - XA * P.adXa[1] : A.p + XA * P.adXa[1];
      lo = Math.min(lo, d1, d2); hi = Math.max(hi, d1, d2);
    }
    // BCD projection: C ± cdBc×BC
    if (P.cdBc) {
      var e1 = bullish ? C.p - dirn * BC * P.cdBc[0] * -1 : C.p + dirn * BC * P.cdBc[0];
      var e2 = bullish ? C.p - dirn * BC * P.cdBc[1] * -1 : C.p + dirn * BC * P.cdBc[1];
      // cleaner: bullish D = C - cdBc*BC ; bearish D = C + cdBc*BC
      e1 = bullish ? C.p - BC * P.cdBc[0] : C.p + BC * P.cdBc[0];
      e2 = bullish ? C.p - BC * P.cdBc[1] : C.p + BC * P.cdBc[1];
      lo = Math.min(lo, e1, e2); hi = Math.max(hi, e1, e2);
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return null;
    return { lo: +lo.toFixed(8), hi: +hi.toFixed(8) };
  }

  // ---- PRZ projection — the "predicting" mode from djoffrey/quantwave:
  // the last 4 confirmed pivots are XABC; for every pattern whose first
  // two ratio gates (abXa, bcAb) already pass, compute where D MUST land
  // for the remaining constraints (cdBc, adXa, abcdEq). Intersect = the
  // Potential Reversal Zone. Causal: only uses confirmed pivots.
  function project(cs, opts) {
    opts = opts || {};
    var piv = zigzag(cs, opts.dev || 0.015);
    if (piv.length < 4) return null;
    var pts = piv.slice(-4);
    var seq = pts.map(function (p) { return p.type; }).join('');
    if (seq !== 'LHLH' && seq !== 'HLHL') return null;
    var X = pts[0], A = pts[1], B = pts[2], C = pts[3];
    var XA = Math.abs(A.p - X.p), AB = Math.abs(B.p - A.p), BC = Math.abs(C.p - B.p);
    if (!XA || !AB || !BC) return null;
    var abXa = AB / XA, bcAb = BC / AB;
    var bullish = seq === 'LHLH'; // D completes low — buy zone
    var zones = [];
    for (var name in PATTERNS) {
      var P = PATTERNS[name];
      if (!P.cdBc && !P.adXa) continue; // ABCD needs its own handling below
      if (P.abXa && !inBand(abXa, P.abXa)) continue;
      if (P.bcAb && !inBand(bcAb, P.bcAb)) continue;
      // candidate D prices from each remaining constraint
      var cands = [];
      if (P.adXa) cands.push(bullish ? A.p - XA * P.adXa[0] : A.p + XA * P.adXa[0],
                             bullish ? A.p - XA * P.adXa[1] : A.p + XA * P.adXa[1]);
      if (P.cdBc) cands.push(bullish ? C.p - BC * P.cdBc[0] : C.p + BC * P.cdBc[0],
                             bullish ? C.p - BC * P.cdBc[1] : C.p + BC * P.cdBc[1]);
      if (!cands.length) continue;
      var lo = Math.min.apply(null, cands), hi = Math.max.apply(null, cands);
      zones.push({ type: name, lo: +lo.toFixed(8), hi: +hi.toFixed(8),
                   mid: +((lo + hi) / 2).toFixed(8) });
    }
    // AB=CD special case: D = C ± AB (in the BC direction)
    if (inBand(bcAb, PATTERNS.ABCD.bcAb)) {
      var dAb = bullish ? C.p - AB : C.p + AB;
      zones.push({ type: 'ABCD', lo: +(dAb * 0.995).toFixed(8), hi: +(dAb * 1.005).toFixed(8),
                   mid: +dAb.toFixed(8) });
    }
    if (!zones.length) return null;
    // tightest consensus: overlapping zones = where multiple patterns agree
    var los = zones.map(function (z) { return z.lo; }), his = zones.map(function (z) { return z.hi; });
    var consLo = Math.max.apply(null, los), consHi = Math.min.apply(null, his);
    var consensus = consHi > consLo ? { lo: +consLo.toFixed(8), hi: +consHi.toFixed(8) } : null;
    var lastC = cs[cs.length - 1].c;
    var inZone = zones.some(function (z) { return lastC >= z.lo && lastC <= z.hi; });
    return { dir: bullish ? 'bullish' : 'bearish', zones: zones, consensus: consensus,
             inZone: inZone, xabc: { X: X.p, A: A.p, B: B.p, C: C.p },
             label: (bullish ? 'bullish' : 'bearish') + ' PRZ' +
                    (inZone ? ' — PRICE IN ZONE' : '') + ' · ' + zones.length + ' pattern(s) projecting' +
                    (consensus ? ' · consensus ' + consensus.lo.toPrecision(4) + '–' + consensus.hi.toPrecision(4) : '') };
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

  g.Harmonics = { zigzag: zigzag, detect: detect, active: active, project: project,
                  PATTERNS: PATTERNS };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.Harmonics;
})(typeof globalThis !== 'undefined' ? globalThis : this);
