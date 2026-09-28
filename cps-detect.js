// CPDetect — named chart-pattern detection over OHLC candles, returning
// drawable geometry: lines (pivot segments, trendlines extended to the last
// bar), levels (horizontal marks like necklines/box edges), and a label
// anchor for the pattern name. Shared by the command deck journal and the
// evidence gallery. Requires globalThis.Harmonics (zigzag + pivots carry
// {t, p, type, i}).
(function (g) {
  'use strict';
  function detect(cs) {
    if (!cs || cs.length < 30 || !g.Harmonics) return [];
    var lastT = cs[cs.length - 1].t;
    var px = function (x) { return x >= 100 ? x.toFixed(1) : x >= 1 ? x.toFixed(3) : x.toPrecision(3); };
    var ext = function (a, b) { // trendline endpoint projected to the last bar
      var dt = b.t - a.t;
      if (dt <= 0) return { t: b.t, p: b.p };
      return { t: lastT, p: b.p + ((b.p - a.p) / dt) * (lastT - b.t) };
    };
    var out = [], seen = {};
    var add = function (name, dir, conf, lines, levels, labelAt, s) {
      if (seen[name]) return; seen[name] = 1;
      out.push({ name: name, dir: dir, conf: conf, lines: lines || [], levels: levels || [], labelAt: labelAt || null, s: s || '' });
    };
    for (var di = 0; di < 2; di++) {
      var piv = g.Harmonics.zigzag(cs, di ? 0.02 : 0.012);
      if (!piv || piv.length < 5) continue;
      var H = piv.filter(function (p) { return p.type === 'H'; }).slice(-5);
      var L = piv.filter(function (p) { return p.type === 'L'; }).slice(-5);
      var tol = 0.03;
      // a triple claims THREE touches of one level — all peaks must fit a
      // single band, stricter than a double's pair tolerance. The old check
      // chained pairs (h3≈h2 ≤3% AND h1≈h2 ≤3%) which let h1↔h3 sit ~6%
      // apart — a sloped line labeled 'TRIPLE TOP'.
      var triTol = 0.02;
      var band = function (ps) {
        var mn = Infinity, mx = -Infinity, sum = 0;
        for (var k = 0; k < ps.length; k++) { mn = Math.min(mn, ps[k].p); mx = Math.max(mx, ps[k].p); sum += ps[k].p; }
        return (mx - mn) / (sum / ps.length);
      };
      var bandMid = function (ps) {
        var mn = Infinity, mx = -Infinity;
        for (var k = 0; k < ps.length; k++) { mn = Math.min(mn, ps[k].p); mx = Math.max(mx, ps[k].p); }
        return (mx + mn) / 2;
      };
      var topFlat = H.length >= 3 && band(H.slice(-3)) <= triTol;
      var botFlat = L.length >= 3 && band(L.slice(-3)) <= triTol;
      var dHv = H.length >= 2 ? Math.abs(H[H.length - 1].p - H[H.length - 2].p) / H[H.length - 2].p : 9;
      var dLv = L.length >= 2 ? Math.abs(L[L.length - 1].p - L[L.length - 2].p) / L[L.length - 2].p : 9;
      // triple-tops AND triple-bottoms coexisting = a rectangle, not two
      // reversals — demote both to doubles; the box structure carries it
      var bothTrip = topFlat && botFlat && dHv <= tol && dLv <= tol;
      // ---- double / triple tops + bottoms, neckline = lowest trough
      // between the outer peaks (Bulkowski: the range's support) ----
      if (H.length >= 2) {
        var h2 = H[H.length - 2], h1 = H[H.length - 1];
        if (Math.abs(h1.p - h2.p) / h2.p <= tol) {
          var tri = topFlat && !bothTrip;
          var first = tri ? H[H.length - 3] : h2;
          var neck = null;
          for (var i = 0; i < piv.length; i++) { var q = piv[i]; if (q.type === 'L' && q.i > first.i && q.i < h1.i && (!neck || q.p < neck.p)) neck = q; }
          var topPts = tri ? H.slice(-3) : [h2, h1], mid = tri ? bandMid(topPts) : (h1.p + h2.p) / 2;
          var seg = topPts.map(function (p) { return { t: p.t, p: p.p }; });
          seg.push({ t: lastT, p: mid });
          add(tri ? 'TRIPLE TOP' : 'DOUBLE TOP', 'bear', 'B',
            [seg],
            neck ? [{ p: neck.p, t: 'neckline' }] : [{ p: mid, t: 'resistance' }],
            { t: h1.t, p: h1.p, ty: 'H' },
            (tri ? 'triple' : 'twin') + ' highs ≈' + px(mid) + (neck ? ' · neckline ' + px(neck.p) : ''));
        }
      }
      if (L.length >= 2) {
        var l2 = L[L.length - 2], l1 = L[L.length - 1];
        if (Math.abs(l1.p - l2.p) / l2.p <= tol) {
          var triB = botFlat && !bothTrip;
          var firstB = triB ? L[L.length - 3] : l2;
          var neck2 = null;
          for (var j = 0; j < piv.length; j++) { var q2 = piv[j]; if (q2.type === 'H' && q2.i > firstB.i && q2.i < l1.i && (!neck2 || q2.p > neck2.p)) neck2 = q2; }
          var botPts = triB ? L.slice(-3) : [l2, l1], midB = triB ? bandMid(botPts) : (l1.p + l2.p) / 2;
          var segB = botPts.map(function (p) { return { t: p.t, p: p.p }; });
          segB.push({ t: lastT, p: midB });
          add(triB ? 'TRIPLE BOTTOM' : 'DOUBLE BOTTOM', 'bull', 'B',
            [segB],
            neck2 ? [{ p: neck2.p, t: 'neckline' }] : [{ p: midB, t: 'support' }],
            { t: l1.t, p: l1.p, ty: 'L' },
            (triB ? 'triple' : 'twin') + ' lows ≈' + px(midB) + (neck2 ? ' · neckline ' + px(neck2.p) : ''));
        }
      }
      // ---- head & shoulders / inverse ----
      if (H.length >= 3) {
        var a = H[H.length - 3], b = H[H.length - 2], c = H[H.length - 1];
        if (b.p > a.p && b.p > c.p && Math.abs(a.p - c.p) / a.p <= 0.06)
          add('HEAD & SHOULDERS', 'bear', 'B',
            [[{ t: a.t, p: a.p }, { t: b.t, p: b.p }, { t: c.t, p: c.p }]],
            [{ p: Math.min(a.p, c.p), t: 'neckline ≈' }],
            { t: b.t, p: b.p, ty: 'H' }, 'head ' + px(b.p) + ' · shoulders ' + px(a.p) + '/' + px(c.p));
      }
      if (L.length >= 3) {
        var a2 = L[L.length - 3], b2 = L[L.length - 2], c2 = L[L.length - 1];
        if (b2.p < a2.p && b2.p < c2.p && Math.abs(a2.p - c2.p) / a2.p <= 0.06)
          add('INVERSE H&S', 'bull', 'B',
            [[{ t: a2.t, p: a2.p }, { t: b2.t, p: b2.p }, { t: c2.t, p: c2.p }]],
            [{ p: Math.max(a2.p, c2.p), t: 'neckline ≈' }],
            { t: b2.t, p: b2.p, ty: 'L' }, 'head ' + px(b2.p) + ' · shoulders ' + px(a2.p) + '/' + px(c2.p));
      }
      // ---- channels / triangles / wedges / rectangles / broadening ----
      if (H.length >= 2 && L.length >= 2) {
        var hh2 = H[H.length - 2], hh1 = H[H.length - 1], ll2 = L[L.length - 2], ll1 = L[L.length - 1];
        var hFlat = Math.abs(hh1.p - hh2.p) / hh2.p <= 0.012, lFlat = Math.abs(ll1.p - ll2.p) / ll2.p <= 0.012;
        var hDn = hh1.p < hh2.p && !hFlat, lUp = ll1.p > ll2.p && !lFlat;
        var hUp = hh1.p > hh2.p && !hFlat, lDn = ll1.p < ll2.p && !lFlat;
        var segH = [{ t: hh2.t, p: hh2.p }, ext(hh2, hh1)], segL = [{ t: ll2.t, p: ll2.p }, ext(ll2, ll1)];
        if (hFlat && lFlat)
          add('RECTANGLE RANGE', null, 'C',
            [segH, segL],
            [{ p: (hh1.p + hh2.p) / 2, t: 'box hi' }, { p: (ll1.p + ll2.p) / 2, t: 'box lo' }],
            { t: hh1.t, p: hh1.p, ty: 'H' }, 'range box ' + px(ll1.p) + '–' + px(hh1.p));
        else if (hDn && lUp)
          add('SYM TRIANGLE', null, 'C', [segH, segL], [],
            { t: hh1.t, p: hh1.p, ty: 'H' }, 'coiling — apex break pending');
        else if (hUp && lUp)
          add('RISING CHANNEL', 'bull', 'C', [segH, segL], [],
            { t: hh1.t, p: hh1.p, ty: 'H' }, 'parallel rising structure');
        else if (hDn && lDn)
          add('FALLING CHANNEL', 'bear', 'C', [segH, segL], [],
            { t: ll1.t, p: ll1.p, ty: 'L' }, 'parallel falling structure');
        else if (hUp && lDn)
          add('BROADENING', null, 'C', [segH, segL], [],
            { t: hh1.t, p: hh1.p, ty: 'H' }, 'expanding volatility — megaphone');
        else if (!hDn && lUp)
          add('RISING WEDGE', 'bear', 'C', [segH, segL], [],
            { t: ll1.t, p: ll1.p, ty: 'L' }, 'rising compression — bearish lean');
        else if (hDn && !lUp)
          add('FALLING WEDGE', 'bull', 'C', [segH, segL], [],
            { t: hh1.t, p: hh1.p, ty: 'H' }, 'falling compression — bullish lean');
      }
      // ---- flags: sharp impulse then tight coil ----
      var n6 = cs.slice(-6), p6 = cs.slice(-14, -6);
      if (p6.length === 8 && n6.length === 6) {
        var imp = (p6[7].c - p6[0].o) / p6[0].o, drift = (n6[5].c - n6[0].o) / n6[0].o;
        var hi6 = -Infinity, lo6 = Infinity;
        n6.forEach(function (c) { if (c.h > hi6) hi6 = c.h; if (c.l < lo6) lo6 = c.l; });
        if (imp > 0.025 && Math.abs(drift) < 0.012)
          add('BULL FLAG', 'bull', 'B',
            [[{ t: n6[0].t, p: hi6 }, { t: n6[5].t, p: hi6 }], [{ t: n6[0].t, p: lo6 }, { t: n6[5].t, p: lo6 }]],
            [{ p: hi6, t: 'flagpole hi' }], { t: n6[5].t, p: hi6, ty: 'H' }, '+' + (imp * 100).toFixed(1) + '% impulse then coil');
        else if (imp < -0.025 && Math.abs(drift) < 0.012)
          add('BEAR FLAG', 'bear', 'B',
            [[{ t: n6[0].t, p: hi6 }, { t: n6[5].t, p: hi6 }], [{ t: n6[0].t, p: lo6 }, { t: n6[5].t, p: lo6 }]],
            [{ p: lo6, t: 'flagpole lo' }], { t: n6[5].t, p: lo6, ty: 'L' }, (imp * 100).toFixed(1) + '% impulse then coil');
      }
      if (out.length) break; // finer sensitivity first, coarse as fallback
    }
    return out.sort(function (a, b) { return (a.conf === 'B' ? 0 : 1) - (b.conf === 'B' ? 0 : 1); }).slice(0, 3);
  }
  g.CPDetect = { detect: detect };
})(typeof window !== 'undefined' ? window : globalThis);
