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

  // ---------- Wyckoff: full schematic — TR, phases A-E, springs, JTC ----------
  // Event grammar: SC/BC -> AR -> ST -> (spring|UTAD) -> test -> (JTC|FTI)
  // -> (LPS|LPSY) -> markup/markdown. Phase = furthest confirmed stage.
  function wyckoff(cs, lookback) {
    var n = cs.length;
    if (n < 40) return null;
    var win = Math.min(lookback || 60, n - 3);
    var W = cs.slice(n - win);
    var off = n - win;
    var TAIL = 8; // events are detected only in the tail — bounds come from the base
    var base = W.slice(0, -TAIL), tail = W.slice(-TAIL);
    var med = function (a) {
      var b = a.slice().sort(function (x, y) { return x - y; });
      return b[Math.floor(b.length / 2)] || 0;
    };
    var volAvg = med(base.map(function (c) { return c.qv || 0; })) || 1;
    var rngAvg = med(base.map(function (c) { return c.h - c.l; })) || 1e-9;

    // trading range bounds: pivot clusters in the BASE only — the tail can't
    // pollute its own levels (a spring's low must never become the support)
    var piv = zigzag ? zigzag(base, 0.012) : [];
    var pivL = piv.filter(function (p) { return p.type === 'L'; }).map(function (p) { return { p: p.p, i: p.i }; });
    var pivH = piv.filter(function (p) { return p.type === 'H'; }).map(function (p) { return { p: p.p, i: p.i }; });
    var allL = base.map(function (c) { return c.l; }), allH = base.map(function (c) { return c.h; });
    var minL = Math.min.apply(null, allL), maxH = Math.max.apply(null, allH);
    var band = (maxH - minL) * 0.12;
    var lowsN = pivL.filter(function (p) { return p.p <= minL + band; });
    var highsN = pivH.filter(function (p) { return p.p >= maxH - band; });
    var support = lowsN.length ? med(lowsN.map(function (x) { return x.p; })) : minL;
    var resist = highsN.length ? med(highsN.map(function (x) { return x.p; })) : maxH;
    var widthPct = support ? (resist - support) / support * 100 : 0;
    var inside = base.filter(function (c) { return c.c >= support * 0.995 && c.c <= resist * 1.005; }).length / base.length;
    var isRange = inside > 0.55 && widthPct > 1.5 && widthPct < 60;

    // event timeline — climaxes from the base, actionable events from the tail
    var ev = [];
    var firstThird = Math.floor(base.length / 3);
    for (var b = 1; b < base.length; b++) {
      var bc = base[b], bvx = (bc.qv || 0) / volAvg, bsp = bc.h - bc.l;
      if (b < firstThird && bvx >= 2.2 && bsp >= rngAvg * 1.8) {
        if (bc.l <= minL + (resist - support) * 0.1)
          ev.push({ t: 'SC', i: off + b, volX: +bvx.toFixed(2) });
        else if (bc.h >= resist - (resist - support) * 0.1)
          ev.push({ t: 'BC', i: off + b, volX: +bvx.toFixed(2) });
      }
    }
    for (var i = 0; i < tail.length; i++) {
      var c = tail[i], vx = (c.qv || 0) / volAvg, spread = c.h - c.l;
      if (!isRange) continue;
      var penDn = (support - c.l) / support;         // penetration below support
      var penUp = (c.h - resist) / resist;           // penetration above resist
      var abs = off + base.length + i;               // absolute candle index
      var lastJTC = ev.filter(function (e) { return e.t === 'JTC'; }).pop();
      var lastSpr = ev.filter(function (e) { return e.t === 'spring'; }).pop();
      var lastFTI = ev.filter(function (e) { return e.t === 'FTI'; }).pop();
      // SPRING — false break of support, closes back inside (not after an FTI —
      // dips below the ice are markdown continuation, not accumulation)
      if (penDn > 0.003 && c.c > support && !(lastFTI && abs - lastFTI.i <= 8))
        ev.push({ t: 'spring', i: abs, level: +support.toFixed(8),
          pen: +(penDn * 100).toFixed(2), volX: +vx.toFixed(2),
          noSupply: vx < 0.8, absorbed: vx > 1.5 });
      // TEST — post-spring pullback holds above spring low on lighter volume
      else if (lastSpr && abs > lastSpr.i && c.l >= support * 0.998 &&
               c.l < support * 1.02 && vx < 0.95 && !lastSpr.tested) {
        lastSpr.tested = true;
        ev.push({ t: 'test', i: abs, volX: +vx.toFixed(2) });
      }
      // JTC — jump across the creek: decisive close above resistance
      else if (penUp > 0.004 && c.c > resist * 1.002 && spread >= rngAvg * 1.2 && vx >= 1.2)
        ev.push({ t: 'JTC', i: abs, level: +resist.toFixed(8),
          volX: +vx.toFixed(2), spreadX: +(spread / rngAvg).toFixed(2) });
      // LPS — pullback after JTC holds above the creek
      else if (lastJTC && abs > lastJTC.i && c.l >= resist * 0.997 &&
               c.c >= resist && vx < 1.2 && !lastJTC.lps) {
        lastJTC.lps = true;
        ev.push({ t: 'LPS', i: abs, volX: +vx.toFixed(2) });
      }
      // UTAD — false break of resistance, closes back inside (not after a JTC —
      // pokes above the creek are markup continuation, not distribution)
      if (penUp > 0.003 && c.c < resist && !(lastJTC && abs - lastJTC.i <= 8))
        ev.push({ t: 'UTAD', i: abs, level: +resist.toFixed(8),
          pen: +(penUp * 100).toFixed(2), volX: +vx.toFixed(2) });
      // FTI — fall through the ice: decisive close below support
      else if (penDn > 0.004 && c.c < support * 0.998 && spread >= rngAvg * 1.2 && vx >= 1.2)
        ev.push({ t: 'FTI', i: abs, level: +support.toFixed(8),
          volX: +vx.toFixed(2) });
      // LPSY — rally after FTI fails under the ice
      else if (lastFTI && abs > lastFTI.i && c.h <= support * 1.003 &&
               c.c <= support && vx < 1.2 && !lastFTI.lpsy) {
        lastFTI.lpsy = true;
        ev.push({ t: 'LPSY', i: abs, volX: +vx.toFixed(2) });
      }
    }

    // phase inference — furthest confirmed stage wins
    var has = function (t) { return ev.some(function (e) { return e.t === t; }); };
    var last = function (t) { return ev.filter(function (e) { return e.t === t; }).pop(); };
    var lastClose = cs[n - 1].c;
    var markup = lastClose > resist * 1.03 && has('JTC');
    var markdown = lastClose < support * 0.97 && has('FTI');
    var type = null, phase = null;
    if (has('JTC') || has('LPS')) { type = 'accumulation'; phase = markup ? 'E' : 'D'; }
    else if (has('FTI') || has('LPSY')) { type = 'distribution'; phase = markdown ? 'E' : 'D'; }
    else if (has('spring') || has('test')) { type = 'accumulation'; phase = 'C'; }
    else if (has('UTAD')) { type = 'distribution'; phase = 'C'; }
    else if (has('SC') || has('BC')) { type = has('SC') ? 'accumulation' : 'distribution'; phase = 'A'; }
    else if (isRange) { type = 'ranging'; phase = 'B'; }

    // freshest actionable event
    var act = last('LPS') || last('JTC') || last('test') || last('spring') ||
              last('LPSY') || last('FTI') || last('UTAD') || null;
    var bias = null, quality = 0;
    if (act) {
      var acc = act.t === 'spring' || act.t === 'test' || act.t === 'JTC' || act.t === 'LPS';
      bias = acc ? 'LONG' : 'SHORT';
      quality = 50;
      if (act.t === 'spring') quality += (act.tested ? 18 : 0) + (act.absorbed ? 12 : act.noSupply ? 8 : 0) + Math.min(act.pen * 4, 10);
      if (act.t === 'JTC') quality += (act.lps ? 18 : 0) + Math.min((act.volX - 1) * 15, 15) + Math.min((act.spreadX - 1) * 10, 8);
      if (act.t === 'UTAD') quality += Math.min(act.pen * 4, 10) + Math.min((act.volX - 1) * 12, 12);
      if (act.t === 'FTI') quality += (act.lpsy ? 18 : 0) + Math.min((act.volX - 1) * 15, 15);
      if (act.t === 'LPS' || act.t === 'LPSY' || act.t === 'test') quality += 22;
      quality = Math.min(100, Math.round(quality));
    }
    var phaseBias = type === 'accumulation' ? (phase === 'D' || phase === 'E' ? 'LONG' : null)
                  : type === 'distribution' ? (phase === 'D' || phase === 'E' ? 'SHORT' : null) : null;
    return {
      type: type, phase: phase,
      event: act ? act.t : null,
      eventDetail: act,
      events: ev.slice(-8).map(function (e) { return e.t; }),
      tr: isRange ? { support: +support.toFixed(8), resist: +resist.toFixed(8), widthPct: +widthPct.toFixed(2) } : null,
      quality: quality,
      bias: bias || phaseBias,
      spring: last('spring') || null, jtc: last('JTC') || null,
      utad: last('UTAD') || null, fti: last('FTI') || null,
      age: act ? n - 1 - act.i : null,
      // go-wyckoff confirmation layer — an event is a hypothesis, not a
      // signal: a spring must HOLD above support to count as accumulation;
      // an upthrust must HOLD below resistance to count as distribution
      springHold: last('spring') ? lastClose > support : null,
      uthrHold: last('UTAD') ? lastClose < resist : null,
      // measured-move: Wyckoff's counting — the TR width projects the
      // markup/markdown leg; invalidation sits at the spring/UTAD extreme
      target: type === 'accumulation' && isRange ? +(resist + (resist - support)).toFixed(8)
            : type === 'distribution' && isRange ? +(support - (resist - support)).toFixed(8) : null,
      invalid: type === 'accumulation' ? +(last('spring') ? Math.min(support, last('spring').i != null ? cs[last('spring').i].l : support) : support * 0.99).toFixed(8)
             : type === 'distribution' ? +(last('UTAD') && cs[last('UTAD').i] ? Math.max(resist, cs[last('UTAD').i].h) : resist * 1.01).toFixed(8) : null,
      phaseConf: type ? Math.min(0.95, 0.4 + ev.length * 0.08 + (phase === 'D' || phase === 'E' ? 0.2 : 0)) : null,
    };
  }

  // ---------- LuxAlgo-style smart money concepts ----------
  // BOS / CHoCH, order blocks, EQH/EQL liquidity pools, premium/discount.
  function smc(cs) {
    var n = cs.length;
    if (n < 30 || !zigzag) return null;
    var piv = zigzag(cs, 0.012);
    var hs = piv.filter(function (p) { return p.type === 'H'; });
    var ls = piv.filter(function (p) { return p.type === 'L'; });
    if (hs.length < 2 || ls.length < 2) return null;
    var lastH = hs[hs.length - 1], prevH = hs[hs.length - 2];
    var lastL = ls[ls.length - 1], prevL = ls[ls.length - 2];
    var close = cs[n - 1].c;
    var uptrend = lastH.p > prevH.p && lastL.p > prevL.p;
    var dntrend = lastH.p < prevH.p && lastL.p < prevL.p;
    var bos = null, choch = null;
    if (uptrend && close > lastH.p) bos = 'bullish';
    if (dntrend && close < lastL.p) bos = 'bearish';
    if (dntrend && close > lastH.p) choch = 'bullish';  // downtrend breaks swing high
    if (uptrend && close < lastL.p) choch = 'bearish';  // uptrend breaks swing low

    // order blocks — last opposite-color candle before a displacement move
    var atr = 0; for (var a = n - 15; a < n; a++) atr += cs[a].h - cs[a].l;
    atr = atr / 15 || 1e-9;
    var obs = [];
    for (var i = Math.max(1, n - 40); i < n - 2; i++) {
      var c = cs[i], nx = cs[i + 1];
      var disp = (nx.c - c.c);
      if (c.c < c.o && disp > atr * 1.5 && nx.c > nx.o)
        obs.push({ dir: 'bullish', top: c.h, bot: c.l, i: i, mitigated: false });
      if (c.c > c.o && -disp > atr * 1.5 && nx.c < nx.o)
        obs.push({ dir: 'bearish', top: c.h, bot: c.l, i: i, mitigated: false });
    }
    obs.forEach(function (o) {
      for (var j = o.i + 2; j < n; j++)
        if ((o.dir === 'bullish' && cs[j].c < o.bot) || (o.dir === 'bearish' && cs[j].c > o.top)) { o.mitigated = true; break; }
    });
    var openObs = obs.filter(function (o) { return !o.mitigated; }).slice(-3);
    var inOB = openObs.find(function (o) { return close <= o.top && close >= o.bot; });

    // equal highs/lows — liquidity pools resting at obvious levels
    var eqh = null, eql = null;
    for (var k = Math.max(0, hs.length - 4); k < hs.length; k++)
      for (var m = k + 1; m < hs.length; m++)
        if (Math.abs(hs[k].p - hs[m].p) / hs[m].p < 0.002) eqh = (hs[k].p + hs[m].p) / 2;
    for (var k2 = Math.max(0, ls.length - 4); k2 < ls.length; k2++)
      for (var m2 = k2 + 1; m2 < ls.length; m2++)
        if (Math.abs(ls[k2].p - ls[m2].p) / ls[m2].p < 0.002) eql = (ls[k2].p + ls[m2].p) / 2;

    // premium/discount — where in the dealing range is price
    var rHi = Math.max.apply(null, hs.map(function (p) { return p.p; }));
    var rLo = Math.min.apply(null, ls.map(function (p) { return p.p; }));
    var eq = rLo + (rHi - rLo) / 2;
    var pos = rHi > rLo ? (close - rLo) / (rHi - rLo) : 0.5;
    var zone = pos > 0.618 ? 'premium' : pos < 0.382 ? 'discount' : 'equilibrium';
    return {
      bos: bos, choch: choch, trend: uptrend ? 'up' : dntrend ? 'down' : 'range',
      orderBlocks: openObs, inOB: inOB || null,
      eqh: eqh, eql: eql,
      zone: zone, zonePos: +pos.toFixed(2), equilibrium: +eq.toFixed(8),
    };
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

  // ---------- price-action EQ levels (quartile gating) ----------
  // Every candle's range splits into quartiles: 0% low / 25% / 50% EQ / 75% /
  // 100% high. Where a candle CLOSES in its own range declares who won the bar;
  // where the NEXT candle sits vs the prior candle's EQ gates continuation.
  function eqLevels(cs) {
    var n = cs.length;
    if (n < 8) return null;
    var quads = function (c) {
      var r = c.h - c.l || 1e-9;
      return { r: r, q25: c.l + r * 0.25, eq: c.l + r * 0.5, q75: c.l + r * 0.75,
               pos: (c.c - c.l) / r, body: Math.abs(c.c - c.o) / r };
    };
    var last = cs[n - 1], prev = cs[n - 2];
    var qL = quads(last), qP = quads(prev);
    var lastQ = qL.pos >= 0.75 ? 'Q4' : qL.pos >= 0.5 ? 'Q3' : qL.pos >= 0.25 ? 'Q2' : 'Q1';
    var prevBull = prev.c > prev.o, strongPrev = qP.body > 0.55;
    // mean-respect: a strong prior candle's 50% EQ acts as the pivot — holding
    // its EQ on the trade's side = the bar's auction was real
    var respect =
      strongPrev && prevBull && last.l >= qP.eq - qP.r * 0.05 && last.c >= qP.eq ? 'bullish-hold'
      : strongPrev && !prevBull && last.h <= qP.eq + qP.r * 0.05 && last.c <= qP.eq ? 'bearish-hold'
      : null;
    // EQ sweep: price crossed the prior candle's midpoint and failed to hold it
    var swept = prevBull && last.c < qP.eq ? 'lost-eq'
              : !prevBull && last.c > qP.eq ? 'reclaimed-eq' : null;
    // consecutive closes on one side of a strong bar's EQ = sustained control
    var streak = 0, side = null;
    for (var i = n - 1; i >= Math.max(1, n - 6); i--) {
      var qi = quads(cs[i]), ref = i > 0 ? quads(cs[i - 1]).eq : qi.eq;
      var d = cs[i].c >= ref ? 'up' : 'dn';
      if (side && d !== side) break;
      side = d; streak++;
    }
    // wick dominance — rejection quartiles
    var uw = last.h - Math.max(last.o, last.c), dw = Math.min(last.o, last.c) - last.l;
    var wick = dw > qL.r * 0.5 ? 'lower-reject' : uw > qL.r * 0.5 ? 'upper-reject' : null;
    // dealing-range quartiles — where price sits in the swing range
    var lo = Math.min.apply(null, cs.slice(-60).map(function (c) { return c.l; }));
    var hi = Math.max.apply(null, cs.slice(-60).map(function (c) { return c.h; }));
    var rPos = hi > lo ? (last.c - lo) / (hi - lo) : 0.5;
    var rangeQ = rPos >= 0.75 ? 'Q4-premium' : rPos >= 0.5 ? 'Q3' : rPos >= 0.25 ? 'Q2' : 'Q1-discount';
    // lean: quartile close + mean respect + range position, gated
    var lean = null;
    if ((lastQ === 'Q4' || respect === 'bullish-hold' || swept === 'reclaimed-eq') && rPos < 0.85) lean = 'LONG';
    if ((lastQ === 'Q1' || respect === 'bearish-hold' || swept === 'lost-eq') && rPos > 0.15) lean = 'SHORT';
    return {
      lastQ: lastQ, closePos: +qL.pos.toFixed(2), bodyPct: +qL.body.toFixed(2),
      prevEQ: qP.eq, respect: respect, swept: swept, streak: streak,
      wick: wick, rangeQ: rangeQ, rangePos: +rPos.toFixed(2), lean: lean,
    };
  }

  // ---------- indicator primitives (sub-engine shared) ----------
  function emaSeries(v, p) {
    var k = 2 / (p + 1), o = [], e = v[0];
    for (var i = 0; i < v.length; i++) { e = i ? v[i] * k + e * (1 - k) : v[i]; o.push(e); }
    return o;
  }
  function rsiSeries(v, p) {
    p = p || 14; var out = new Array(v.length).fill(null);
    if (v.length <= p) return out;
    var g = 0, l = 0, i, d;
    for (i = 1; i <= p; i++) { d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= p; l /= p; out[p] = 100 - 100 / (1 + (l ? g / l : 1e9));
    for (i = p + 1; i < v.length; i++) {
      d = v[i] - v[i - 1];
      g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p;
      out[i] = 100 - 100 / (1 + (l ? g / l : 1e9));
    }
    return out;
  }
  // aggregate candles k:1 into a higher timeframe
  function agg(cs, k) {
    var out = [];
    for (var i = 0; i + k <= cs.length; i += k) {
      var b = cs.slice(i, i + k);
      out.push({ t: b[0].t, o: b[0].o, c: b[k - 1].c,
                 h: Math.max.apply(null, b.map(function (c) { return c.h; })),
                 l: Math.min.apply(null, b.map(function (c) { return c.l; })),
                 qv: b.reduce(function (a, c) { return a + (c.qv || 0); }, 0) });
    }
    return out;
  }
  // price-vs-indicator divergence on the last two pivots (regular + hidden)
  function divergence(cs, ind, dev) {
    var p = zigzag(cs, dev || 0.012);
    var hs = p.filter(function (x) { return x.type === 'H'; }),
        ls = p.filter(function (x) { return x.type === 'L'; });
    var at = function (i) { return ind[i] == null ? null : ind[i]; };
    var cands = [];
    if (ls.length >= 2) {
      var a = ls[ls.length - 2], b = ls[ls.length - 1], ia = at(a.i), ib = at(b.i);
      if (ia != null && ib != null) {
        if (b.p < a.p && ib > ia) cands.push({ type: 'bullish', age: cs.length - 1 - b.i });
        else if (b.p > a.p && ib < ia) cands.push({ type: 'hidden-bull', age: cs.length - 1 - b.i });
      }
    }
    if (hs.length >= 2) {
      var a2 = hs[hs.length - 2], b2 = hs[hs.length - 1], ja = at(a2.i), jb = at(b2.i);
      if (ja != null && jb != null) {
        if (b2.p > a2.p && jb < ja) cands.push({ type: 'bearish', age: cs.length - 1 - b2.i });
        else if (b2.p < a2.p && jb > ja) cands.push({ type: 'hidden-bear', age: cs.length - 1 - b2.i });
      }
    }
    if (!cands.length) return null;
    cands.sort(function (x, y) { return x.age - y.age; });
    return cands[0];
  }
  // pivot-sequence trend: HH+HL up / LH+LL down / mixed range
  function trendOf(cs, dev) {
    if (!cs || cs.length < 8) return null;
    var p = zigzag(cs, dev || 0.015);
    var hs = p.filter(function (x) { return x.type === 'H'; }),
        ls = p.filter(function (x) { return x.type === 'L'; });
    if (hs.length < 2 || ls.length < 2) {
      // too few pivots (smooth trend) — fall back to regression slope
      var sl = linSlope(cs.map(function (c) { return c.c; }), Math.min(30, cs.length));
      var st = sl > 0.005 ? 'up' : sl < -0.005 ? 'down' : 'range';
      return { trend: st, dir: st === 'up' ? 'bull' : st === 'down' ? 'bear' : null, lastPivot: null };
    }
    var hh = hs[hs.length - 1].p > hs[hs.length - 2].p,
        hl = ls[ls.length - 1].p > ls[ls.length - 2].p;
    var t = hh && hl ? 'up' : !hh && !hl ? 'down' : 'range';
    var lastP = p[p.length - 1];
    return { trend: t, dir: t === 'up' ? 'bull' : t === 'down' ? 'bear' : null,
             lastPivot: lastP ? lastP.type : null };
  }
  function linSlope(v, n) {
    var s = v.slice(-n); if (s.length < 4) return 0;
    var x0 = s[0], x1 = s[s.length - 1];
    // normalize by the mean |value| of the window, not |x0| — cumulative
    // series like OBV can sit near zero where |x0| sends the slope to ±huge
    // and 'flat' becomes impossible; for prices mean≈x0 so nothing changes
    var scale = s.reduce(function (a, x) { return a + Math.abs(x); }, 0) / s.length;
    var den = Math.max(Math.abs(x0), scale * 0.1);
    return den ? (x1 - x0) / den : 0;
  }
  function obvSeries(cs) {
    var o = [0];
    for (var i = 1; i < cs.length; i++)
      o.push(o[i - 1] + (cs[i].c > cs[i - 1].c ? 1 : cs[i].c < cs[i - 1].c ? -1 : 0) * (cs[i].qv || 0));
    return o;
  }

  // ---------- ENGINE: RSI + divergences ----------
  function rsiEng(cs) {
    var cl = cs.map(function (c) { return c.c; });
    if (cl.length < 20) return null;
    var r = rsiSeries(cl), last = r[r.length - 1];
    if (last == null) return null;
    var zone = last <= 30 ? 'oversold' : last >= 70 ? 'overbought' : last <= 42 ? 'low' : last >= 58 ? 'high' : 'neutral';
    var div = divergence(cs, r, 0.012);
    // RSI failure swing — RSI tags the extreme, falls back, then breaks the
    // reaction trough WITHOUT retagging the extreme: momentum died at the
    // excursion, not at divergence — the sharper reversal signature
    var fs = null, hi7 = -1, hiIdx = -1, lo3 = 101, loIdx = -1;
    for (var fi = r.length - 2; fi > r.length - 18 && fi > 0; fi--) {
      if (r[fi] == null) continue;
      if (r[fi] >= 70 && r[fi] > hi7) { hi7 = r[fi]; hiIdx = fi; break; }
    }
    if (hiIdx > 0) { for (var fj = hiIdx + 1; fj < r.length - 1; fj++) if (r[fj] != null && r[fj] < lo3) { lo3 = r[fj]; loIdx = fj; }
      if (loIdx > hiIdx && last < lo3) fs = 'bear'; }
    if (!fs) { var lo7 = 101; loIdx = -1;
      for (var fk = r.length - 2; fk > r.length - 18 && fk > 0; fk--) {
        if (r[fk] == null) continue;
        if (r[fk] <= 30 && r[fk] < lo7) { lo7 = r[fk]; loIdx = fk; break; }
      }
      if (loIdx > 0) { var hi3 = -1, hi3Idx = -1;
        for (var fl = loIdx + 1; fl < r.length - 1; fl++) if (r[fl] != null && r[fl] > hi3) { hi3 = r[fl]; hi3Idx = fl; }
        if (hi3Idx > loIdx && last > hi3) fs = 'bull'; } }
    var dir = div ? (div.type.indexOf('bull') >= 0 ? 'bull' : 'bear')
            : fs ? fs : last <= 30 ? 'bull' : last >= 70 ? 'bear' : last > 50 ? 'bull' : 'bear';
    return { dir: dir, rsi: +last.toFixed(1), zone: zone, div: div ? div.type : null, divAge: div ? div.age : null,
      failSwing: fs,
      label: 'RSI ' + last.toFixed(1) + ' ' + zone + (div ? ' · ' + div.type + ' divergence ' + div.age + 'b ago' : ' · no divergence')
        + (fs ? ' · ' + fs + ' failure swing' : '') };
  }
  // ---------- ENGINE: MACD ----------
  function macdEng(cs) {
    var cl = cs.map(function (c) { return c.c; });
    if (cl.length < 36) return null;
    var e12 = emaSeries(cl, 12), e26 = emaSeries(cl, 26);
    var m = cl.map(function (_, i) { return e12[i] - e26[i]; });
    var sig = emaSeries(m, 9), hist = m.map(function (x, i) { return x - sig[i]; });
    var n = cl.length, h0 = hist[n - 1], cross = null;
    for (var i = n - 1; i > Math.max(0, n - 30); i--)
      if ((hist[i] > 0) !== (hist[i - 1] > 0)) { cross = { dir: h0 > 0 ? 'bull' : 'bear', age: n - 1 - i }; break; }
    var rising = h0 > hist[n - 2] && hist[n - 2] > hist[n - 3];
    var falling = h0 < hist[n - 2] && hist[n - 2] < hist[n - 3];
    var div = divergence(cs, m, 0.012);
    // histogram divergence — momentum peaks decaying against price peaks
    // fires earlier than MACD-line divergence (hist leads the line by a leg)
    var hdiv = divergence(cs, hist, 0.02);
    var dir = div ? (div.type.indexOf('bull') >= 0 ? 'bull' : 'bear')
            : hdiv && hdiv.age <= 6 ? (hdiv.type.indexOf('bull') >= 0 ? 'bull' : 'bear')
            : cross && cross.age <= 8 ? cross.dir
            : h0 > 0 ? 'bull' : 'bear';
    return { dir: dir, aboveZero: m[n - 1] > 0, cross: cross ? cross.dir + ' ' + cross.age + 'b' : null,
             histDir: rising ? 'rising' : falling ? 'falling' : 'flat', div: div ? div.type : null,
             histDiv: hdiv ? hdiv.type : null, histDivAge: hdiv ? hdiv.age : null,
      label: 'MACD ' + (m[n - 1] > 0 ? 'above' : 'below') + ' zero · hist ' + (rising ? 'rising' : falling ? 'falling' : 'flat')
             + (cross ? ' · ' + cross.dir + ' cross ' + cross.age + 'b ago' : '') + (div ? ' · ' + div.type + ' div' : '')
             + (hdiv ? ' · hist ' + hdiv.type + ' div ' + hdiv.age + 'b' : '') };
  }
  // ---------- ENGINE: Volume + OBV ----------
  function obvEng(cs) {
    if (cs.length < 24) return null;
    var obv = obvSeries(cs), cl = cs.map(function (c) { return c.c; });
    var oS = linSlope(obv, 20), pS = linSlope(cl, 20);
    var div = divergence(cs, obv, 0.012);
    var mxO = Math.max.apply(null, obv.slice(-60, -1)), mnO = Math.min.apply(null, obv.slice(-60, -1));
    var mxP = Math.max.apply(null, cl.slice(-60, -1)), mnP = Math.min.apply(null, cl.slice(-60, -1));
    var lastO = obv[obv.length - 1], lastP = cl[cl.length - 1];
    var stealth = lastO >= mxO && lastP < mxP, distrib = lastO <= mnO && lastP > mnP;
    // OBV breakout confirmation — OBV punching to a new range extreme
    // BEFORE price does is the leading tell (accumulation running ahead of
    // the tape); price at its own extreme without OBV = unconfirmed break
    var obvBrkUp = lastO >= mxO, obvBrkDn = lastO <= mnO,
        pxBrkUp = lastP >= mxP, pxBrkDn = lastP <= mnP;
    var leadBull = obvBrkUp && !pxBrkUp, leadBear = obvBrkDn && !pxBrkDn,
        unconfBrk = (pxBrkUp && !obvBrkUp) || (pxBrkDn && !obvBrkDn);
    var dir = div ? (div.type.indexOf('bull') >= 0 ? 'bull' : 'bear')
            : stealth ? 'bull' : distrib ? 'bear' : leadBull ? 'bull' : leadBear ? 'bear'
            : oS > 0.001 ? 'bull' : oS < -0.001 ? 'bear' : null;
    return { dir: dir, obvSlope: +(oS * 100).toFixed(2), priceSlope: +(pS * 100).toFixed(2),
             div: div ? div.type : null, stealth: stealth, distrib: distrib,
             leadBull: leadBull, leadBear: leadBear, unconfirmedBreak: unconfBrk,
      label: 'OBV ' + (oS > 0 ? 'rising' : 'falling') + ' ' + (oS * 100).toFixed(1) + '%/20b vs price ' + (pS * 100).toFixed(1) + '%'
             + (stealth ? ' · stealth accumulation (OBV new high, price lagging)' : distrib ? ' · distribution (OBV new low, price holding)' : '')
             + (div ? ' · ' + div.type + ' div' : '') };
  }
  // ---------- ENGINE: Dow Theory via price-vs-OBV confirmation ----------
  // Dow: volume must confirm the trend; trends persist until proven reversed.
  // Simplified to the price-vs-OBV study — when volume flows lead price, the
  // quiet phases (accumulation/distribution) show before the move.
  function dowEng(cs) {
    if (cs.length < 30) return null;
    var pt = trendOf(cs, 0.02), obv = obvSeries(cs);
    var oS = linSlope(obv, 30), pS = linSlope(cs.map(function (c) { return c.c; }), 30);
    var oT = oS > 0.002 ? 'up' : oS < -0.002 ? 'down' : 'flat';
    var pT = pt ? pt.trend : 'range';
    var phase, confirmed;
    if (pT === 'up' && oT === 'up') { phase = 'markup'; confirmed = true; }
    else if (pT === 'down' && oT === 'down') { phase = 'markdown'; confirmed = true; }
    else if ((pT !== 'up') && oT === 'up') { phase = 'accumulation'; confirmed = false; }
    else if ((pT !== 'down') && oT === 'down') { phase = 'distribution'; confirmed = false; }
    else { phase = 'unclear'; confirmed = false; }
    var dir = phase === 'accumulation' || phase === 'markup' ? 'bull'
            : phase === 'distribution' || phase === 'markdown' ? 'bear' : null;
    return { dir: dir, phase: phase, confirmed: confirmed, priceTrend: pT, obvTrend: oT,
      label: 'Dow: ' + phase + (confirmed ? ' (volume confirms)' : ' (non-confirmation — volume leads)')
             + ' · price ' + pT + ' / OBV ' + oT };
  }
  // ---------- ENGINE: trend reversal (minor flips inside major) ----------
  function revEng(cs, ev) {
    var minor = trendOf(cs.slice(-18), 0.008), major = trendOf(cs, 0.02);
    if (!minor || !major || minor.trend === 'range' || major.trend === 'range' || minor.trend === major.trend) return null;
    var wantBull = minor.trend === 'up'; // minor up inside major down = bullish reversal attempt
    var trig = ev && ((ev.sfp && (ev.sfp.type === 'bullish') === wantBull)
      || (ev.mc && ev.mc.choch && (ev.mc.choch === 'bullish') === wantBull)
      || (ev.eng && ev.eng.rsi && ev.eng.rsi.div && (ev.eng.rsi.div.indexOf('bull') >= 0) === wantBull)
      || (ev.w && (wantBull ? /spring|jtc|lps|test/.test(ev.w.event || '') : /utad|fti|lpsy/.test(ev.w.event || ''))));
    return { dir: wantBull ? 'bull' : 'bear', confirmed: !!trig,
      label: 'trend reversal ' + (wantBull ? 'bullish' : 'bearish') + ': minor ' + minor.trend + ' vs major ' + major.trend
             + (trig ? ' · trigger confirmed' : ' · unconfirmed — no trigger yet') };
  }
  // ---------- ENGINE: multi-timeframe alignment ----------
  function mtfEng(cs) {
    var ltf = trendOf(cs, 0.01), mtf = trendOf(agg(cs, 4), 0.015), htf = trendOf(agg(cs, 8), 0.02);
    if (!ltf || !mtf || !htf) return null;
    var ts = [ltf.trend, mtf.trend, htf.trend];
    var ups = ts.filter(function (t) { return t === 'up'; }).length,
        dns = ts.filter(function (t) { return t === 'down'; }).length;
    var aligned = ups === 3 || dns === 3;
    var dir = ups > dns ? 'bull' : dns > ups ? 'bear' : null;
    return { dir: dir, aligned: aligned, ltf: ltf.trend, mtf: mtf.trend, htf: htf.trend,
      label: 'MTF 1h ' + ltf.trend + ' · 4h ' + mtf.trend + ' · 8h ' + htf.trend
             + (aligned ? ' — fully aligned' : ' — mixed/transition') };
  }

  // ---------- ENGINE: multi-timeframe deep read ----------
  // Each timeframe gets a real mini-analysis — pivot structure, RSI zone,
  // MACD histogram direction, price-vs-EMA20 posture — then the stack read:
  // full agreement (STACKED), HTF leading while LTF pulls back (the elite
  // buy-the-dip / sell-the-rip context), or a conflicted market (MIXED).
  // frames: { '15m': cs, '1H': cs, '4H': cs, '1D': cs } — any subset ≥2 works.
  function mtfDeep(frames) {
    if (!frames) return null;
    var order = ['15m', '1H', '4H', '1D'];
    var cells = {}, n = 0, votes = { bull: 0, bear: 0 };
    order.forEach(function (tf) {
      var cs = frames[tf];
      if (!cs || cs.length < 20) return;
      var cl = cs.map(function (c) { return c.c; });
      var tr = trendOf(cs, 0.015);
      var r = rsiSeries(cl), rv = r[r.length - 1];
      var e12 = emaSeries(cl, 12), e26 = emaSeries(cl, 26);
      var m = e12[cl.length - 1] - e26[cl.length - 1];
      var mPrev = e12[cl.length - 2] - e26[cl.length - 2];
      var e20 = emaSeries(cl, 20), e50 = cl.length >= 50 ? emaSeries(cl, 50) : null;
      var px = cl[cl.length - 1];
      var vsE20 = +((px / e20[e20.length - 1] - 1) * 100).toFixed(2);
      var vsE50 = e50 ? +((px / e50[e50.length - 1] - 1) * 100).toFixed(2) : null;
      // three votes: structure trend, momentum (RSI tilt + MACD above zero),
      // posture (price vs EMA20/50)
      var v = 0;
      if (tr && tr.dir) v += tr.dir === 'bull' ? 1 : -1;
      if (rv != null) v += rv >= 55 ? 1 : rv <= 45 ? -1 : 0;
      if (m > 0 || (mPrev <= 0 && m > mPrev)) v += 1; else if (m < 0 || (mPrev >= 0 && m < mPrev)) v -= 1;
      var dir = v >= 2 ? 'bull' : v <= -2 ? 'bear' : v > 0 ? 'bull' : v < 0 ? 'bear' : null;
      if (dir) votes[dir]++;
      cells[tf] = {
        dir: dir, str: Math.round(Math.abs(v) / 3 * 100),
        trend: tr ? tr.trend : null, rsi: rv != null ? +rv.toFixed(1) : null,
        macd: m > 0 ? 'above' : 'below', macdTurn: m > mPrev ? 'rising' : 'falling',
        vsE20: vsE20, vsE50: vsE50,
        label: (tr ? tr.trend : '?') + ' · RSI ' + (rv != null ? rv.toFixed(0) : '—')
               + ' · MACD ' + (m > 0 ? 'above' : 'below') + ' zero/' + (m > mPrev ? 'rising' : 'falling')
               + ' · ' + (vsE20 >= 0 ? '+' : '') + vsE20 + '% vs E20',
      };
      n++;
    });
    if (n < 2) return null;
    var dir = votes.bull > votes.bear ? 'bull' : votes.bear > votes.bull ? 'bear' : null;
    var htf = cells['1D'] || cells['4H'], ltf = cells['15m'] || cells['1H'];
    var stack, kind;
    var agree = Math.max(votes.bull, votes.bear);
    if (dir && agree === n) { stack = 'STACKED ' + dir.toUpperCase(); kind = 'stacked'; }
    else if (htf && ltf && htf.dir && ltf.dir && htf.dir !== ltf.dir) {
      stack = 'HTF ' + htf.dir.toUpperCase() + ' · LTF pullback'; kind = 'pullback';
    } else { stack = 'MIXED ' + votes.bull + '/' + votes.bear; kind = 'mixed'; }
    // direction for the vote pool: stacked/pullback follow the HTF read;
    // mixed contributes nothing
    var vdir = kind === 'pullback' ? htf.dir : dir;
    return {
      cells: cells, frames: order.filter(function (tf) { return cells[tf]; }),
      dir: vdir, stack: stack, kind: kind, agree: agree, n: n,
      label: 'MTF ' + stack + ' — ' + agree + '/' + n + ' frames ' + (dir || 'split'),
    };
  }

  // ---------- Liquidity Levels (TTC doctrine — Anni Snelleksz) ----------
  // Liquidity = resting stop orders. Pools stack above equal/swing/session
  // highs (buy-side: short stops + breakout buys) and below equal/swing/
  // session lows (sell-side: long stops + breakdown sells). The playbook:
  // a pool is swept, the sweep candle closes back inside the level
  // (reclaim), and displacement carries price toward the OPPOSING pool.
  // Zone filter: short sweeps only count in premium, long sweeps in
  // discount. Inducement = a minor pool engineered inside the leg to be
  // raided before the real target — it warns the trade may still stop-run
  // the closer level first.
  function liquidity(cs) {
    var n = cs.length;
    if (n < 60 || !zigzag) return null;
    var px = cs[n - 1].c;
    var DAY = 864e5, lastT = cs[n - 1].t;

    // --- pool registry: merge overlapping levels, count touches ---
    var pools = []; // {px, side:'bsl'|'ssl', src:{}, touches, i, str}
    var TOL = 0.0015;
    function pool(price, side, src, i) {
      for (var j = 0; j < pools.length; j++) {
        var p = pools[j];
        if (p.side === side && Math.abs(p.px - price) / price < TOL) {
          p.src[src] = true; p.touches++;
          p.px = (p.px * (p.touches - 1) + price) / p.touches;
          if (i > p.i) p.i = i;
          return;
        }
      }
      var q = { px: price, side: side, src: {}, touches: 1, i: i };
      q.src[src] = true; pools.push(q);
    }
    // swing pools at two scales — minor (inducement) + major (real pools)
    var zmin = zigzag(cs, 0.008), zmaj = zigzag(cs, 0.02);
    zmin.forEach(function (p) { pool(p.p, p.type === 'H' ? 'bsl' : 'ssl', 'minor', p.i); });
    zmaj.forEach(function (p) { pool(p.p, p.type === 'H' ? 'bsl' : 'ssl', 'swing', p.i); });
    // raw local extrema — zigzag misses prominent highs/lows when the leg
    // deviation stays under its threshold; a ±3-bar extremum never lies
    for (var e = 3; e < n - 3; e++) {
      var isH = true, isL = true;
      for (var f = 1; f <= 3 && (isH || isL); f++) {
        if (cs[e].h < cs[e - f].h || cs[e].h < cs[e + f].h) isH = false;
        if (cs[e].l > cs[e - f].l || cs[e].l > cs[e + f].l) isL = false;
      }
      if (isH) pool(cs[e].h, 'bsl', 'swing', e);
      if (isL) pool(cs[e].l, 'ssl', 'swing', e);
    }
    // session anchors — prior-day hi/lo, week-to-date hi/lo, Asia 00–08 UTC
    var d0 = Math.floor(lastT / DAY) * DAY;
    var slice = function (a, b) { return cs.filter(function (c) { return c.t >= a && c.t < b; }); };
    var anchors = [
      ['pdh', 'pdl', slice(d0 - DAY, d0)],
      ['wtd-hi', 'wtd-lo', slice(d0 - ((new Date(d0).getUTCDay() + 6) % 7) * DAY, lastT)],
      ['asia-hi', 'asia-lo', slice(d0, Math.min(d0 + 8 * 36e5, lastT))],
      ['day-hi', 'day-lo', slice(d0, lastT)],
    ];
    anchors.forEach(function (a) {
      var seg = a[2];
      if (seg.length < 4) return;
      var hiI = 0, loI = 0;
      seg.forEach(function (c, k) { if (c.h > seg[hiI].h) hiI = k; if (c.l < seg[loI].l) loI = k; });
      pool(seg[hiI].h, 'bsl', a[0], n - seg.length + hiI);
      pool(seg[loI].l, 'ssl', a[1], n - seg.length + loI);
    });
    // equal highs/lows — raw candle prints ≥4 bars apart inside 0.2% = an
    // engineered pool (the level algos keep defending = where stops stack)
    for (var a2 = 0; a2 < n - 4; a2++) {
      for (var b2 = a2 + 4; b2 < n; b2++) {
        if (Math.abs(cs[a2].h - cs[b2].h) / cs[b2].h < 0.002)
          pool((cs[a2].h + cs[b2].h) / 2, 'bsl', 'equal', b2);
        if (Math.abs(cs[a2].l - cs[b2].l) / cs[b2].l < 0.002)
          pool((cs[a2].l + cs[b2].l) / 2, 'ssl', 'equal', b2);
      }
    }
    // round numbers — adaptive magnitude (BTC 100s, alts ~2 significant digits)
    var step = Math.pow(10, Math.floor(Math.log10(px)) - 1);
    if (px / step > 9) step *= 5;
    for (var r0 = Math.floor(px / step) * step - step * 2; r0 < px + step * 3; r0 += step) {
      if (Math.abs(r0 - px) / px < 0.0008) continue; // sitting on it — not a pool yet
      pool(r0, r0 > px ? 'bsl' : 'ssl', 'round', n - 1);
    }
    // strength: touches + anchor bonus; fresh pools beat stale ones
    pools.forEach(function (p) {
      var s = 30 + Math.min(30, (p.touches - 1) * 15);
      if (p.src['equal']) s += 15;
      ['pdh', 'pdl', 'wtd-hi', 'wtd-lo', 'asia-hi', 'asia-lo'].forEach(function (k) {
        if (p.src[k]) s += 10;
      });
      if (p.src['round']) s += 5;
      p.ageH = n - 1 - p.i;
      if (p.ageH > 72) s -= 10;
      p.str = Math.min(100, s);
      // engineered/anchored pools are the elite liquidity — algos defend
      // equal highs and session extremes; a minor swing nick is not a pool
      p.elite = !!(p.src['equal'] || p.src['pdh'] || p.src['pdl'] ||
                   p.src['wtd-hi'] || p.src['wtd-lo'] || p.src['asia-hi'] ||
                   p.src['asia-lo'] || p.src['day-hi'] || p.src['day-lo']);
      p.distPct = +((Math.abs(p.px - px) / px) * 100).toFixed(2);
      p.swept = false;
    });
    // --- sweep scan: recent candles wicking a pool and closing back inside
    var medianR = (function () {
      var rr = cs.slice(-24).map(function (c) { return c.h - c.l; }).sort(function (a, b) { return a - b; });
      return rr[Math.floor(rr.length / 2)] || 1e-9;
    })();
    var sweeps = [];
    for (var i = Math.max(2, n - 12); i < n; i++) {
      var c = cs[i];
      var bodyHi = Math.max(c.o || c.c, c.c), bodyLo = Math.min(c.o || c.c, c.c);
      pools.forEach(function (p) {
        if (p.side === 'bsl' && c.h > p.px * 1.0003 && bodyHi < p.px) {
          var broken = false;
          for (var j = i + 1; j < n; j++)
            if (cs[j].c > p.px * 1.001 || (cs[j].o || cs[j].c) > p.px * 1.001) { broken = true; break; }
          if (!broken) {
            p.swept = true;
            sweeps.push({ side: 'bsl', px: p.px, wickPx: c.h, i: i, age: n - 1 - i,
                          disp: (c.h - bodyLo) / medianR, pool: p });
          }
        }
        if (p.side === 'ssl' && c.l < p.px * 0.9997 && bodyLo > p.px) {
          var broken2 = false;
          for (var j2 = i + 1; j2 < n; j2++)
            if (cs[j2].c < p.px * 0.999 || (cs[j2].o || cs[j2].c) < p.px * 0.999) { broken2 = true; break; }
          if (!broken2) {
            p.swept = true;
            sweeps.push({ side: 'ssl', px: p.px, wickPx: c.l, i: i, age: n - 1 - i,
                          disp: (bodyHi - c.l) / medianR, pool: p });
          }
        }
      });
    }
    // premium/discount of the 60h dealing range — zone gate
    var lo60 = Math.min.apply(null, cs.slice(-60).map(function (c) { return c.l; }));
    var hi60 = Math.max.apply(null, cs.slice(-60).map(function (c) { return c.h; }));
    var zPos = hi60 > lo60 ? (px - lo60) / (hi60 - lo60) : 0.5;
    var zone = zPos > 0.618 ? 'premium' : zPos < 0.382 ? 'discount' : 'equilibrium';
    // pick the best qualifying sweep — pool strength weighted against age:
    // a fresh equal-highs raid beats a stale one; a marginal minor nick
    // never outranks a real pool just for being newer
    sweeps.sort(function (a, b) {
      return (b.pool.elite ? 1 : 0) - (a.pool.elite ? 1 : 0) ||
             (b.pool.str - b.age * 8 + b.disp * 10) - (a.pool.str - a.age * 8 + a.disp * 10);
    });
    var sw = sweeps.find(function (s2) {
      return s2.side === 'bsl' ? zone !== 'discount' : zone !== 'premium';
    });
    var setup = null;
    if (sw && sw.age <= 10) {
      var dir = sw.side === 'bsl' ? 'SHORT' : 'LONG';
      var anchor = ['pdh', 'pdl', 'asia-hi', 'asia-lo', 'equal'].some(function (k) { return sw.pool.src[k]; });
      var zoneOk = (dir === 'SHORT') === (zone === 'premium') || (dir === 'LONG') === (zone === 'discount');
      var g = 'C';
      if (anchor && zoneOk && sw.disp >= 1.2 && sw.age <= 6) g = 'A';
      else if (anchor && sw.disp >= 0.8) g = 'B';
      setup = { dir: dir, grade: g, levelPx: +sw.px.toFixed(8), wickPx: +sw.wickPx.toFixed(8),
                sweepDepthPct: +((Math.abs(sw.wickPx - sw.px) / sw.px) * 100).toFixed(2),
                age: sw.age, poolStr: sw.pool.str };
    }
    // nearest live pools each side + inducement (minor pool in the way)
    var bsl = pools.filter(function (p) { return p.side === 'bsl' && !p.swept && p.px > px; })
                   .sort(function (a, b) { return a.px - b.px; });
    var ssl = pools.filter(function (p) { return p.side === 'ssl' && !p.swept && p.px < px; })
                   .sort(function (a, b) { return b.px - a.px; });
    // opposing pool = the draw — TTC targets the next MAJOR pool; a
    // minor-only pool sitting in the path is inducement (fuel to be raided
    // first), not the real target
    var isMinorOnly = function (p) {
      var ks = Object.keys(p.src);
      return ks.length === 1 && ks[0] === 'minor';
    };
    var oppSide = setup && setup.dir === 'SHORT' ? ssl : bsl;
    var targetPool = null, inducement = null;
    if (setup) {
      for (var t2 = 0; t2 < oppSide.length; t2++) {
        var pp = oppSide[t2];
        if (!isMinorOnly(pp)) { targetPool = pp; break; }
        if (pp.distPct > 0.3 && !inducement) inducement = { px: pp.px, distPct: pp.distPct };
      }
      if (!targetPool) targetPool = oppSide[0] || null;
    }
    return {
      setup: setup,
      sweep: sw ? { side: sw.side, px: +sw.px.toFixed(8), wickPx: +sw.wickPx.toFixed(8),
                    age: sw.age, disp: +sw.disp.toFixed(2), poolStr: sw.pool.str } : null,
      zone: zone, zonePos: +zPos.toFixed(2),
      bsl: bsl[0] ? { px: +bsl[0].px.toFixed(8), distPct: bsl[0].distPct, str: bsl[0].str, src: Object.keys(bsl[0].src) } : null,
      ssl: ssl[0] ? { px: +ssl[0].px.toFixed(8), distPct: ssl[0].distPct, str: ssl[0].str, src: Object.keys(ssl[0].src) } : null,
      pools: { bsl: bsl.length, ssl: ssl.length },
      inducement: inducement,
      targetPx: targetPool ? +targetPool.px.toFixed(8) : null,
      targetDistPct: targetPool ? +((Math.abs(targetPool.px - px) / px) * 100).toFixed(2) : null,
    };
  }

  // ---------- composite ----------
  // ---------- Ichimoku Kinko Hyo (9/26/52) — trend, equilibrium, momentum
  // in one read. Cloud projected "now" uses the values computed 26 bars ago;
  // chikou compares current close vs the close 26 bars back. ----------
  function ichimoku(cs) {
    var n = cs.length; if (n < 60) return null;
    var mid = function (i, p) {
      var h = -Infinity, l = Infinity;
      for (var j = Math.max(0, i - p + 1); j <= i; j++) {
        if (cs[j].h > h) h = cs[j].h; if (cs[j].l < l) l = cs[j].l;
      }
      return (h + l) / 2;
    };
    var i = n - 1, px = cs[i].c;
    var tenkan = mid(i, 9), kijun = mid(i, 26);
    var j26 = Math.max(0, i - 26);
    var cA = (mid(j26, 9) + mid(j26, 26)) / 2, cB = mid(j26, 52);
    var cTop = Math.max(cA, cB), cBot = Math.min(cA, cB);
    var vs = px > cTop ? 'above' : px < cBot ? 'below' : 'inside';
    var cross = null;
    for (var k = i; k > i - 12 && k > 0; k--) {
      var t0 = mid(k, 9), k0 = mid(k, 26), t1 = mid(k - 1, 9), k1 = mid(k - 1, 26);
      if ((t0 > k0) !== (t1 > k1)) { cross = { dir: t0 > k0 ? 'bull' : 'bear', age: i - k }; break; }
    }
    var chikou = i >= 26 ? (px > cs[i - 26].c ? 'bull' : px < cs[i - 26].c ? 'bear' : null) : null;
    var dir = vs === 'above' && tenkan > kijun ? 'bull' : vs === 'below' && tenkan < kijun ? 'bear' : null;
    return {
      dir: dir, vs: vs, tenkan: tenkan, kijun: kijun, cloudTop: cTop, cloudBot: cBot,
      cross: cross, chikou: chikou,
      label: 'price ' + vs + ' cloud · T' + (tenkan > kijun ? '>' : '<') + 'K'
        + (cross ? ' · ' + cross.dir + ' TK cross ' + cross.age + 'b ago' : '')
        + (chikou ? ' · chikou ' + chikou : '')
    };
  }

  // ---------- MA stack: EMA20/50/200 + SMA50/200 — alignment order and the
  // crossovers (golden/death, E20/50) that mark regime flips ----------
  function maStack(cs) {
    var n = cs.length; if (n < 60) return null;
    var cl = cs.map(function (c) { return c.c; });
    var smaWin = function (i, p) {
      if (i - p + 1 < 0) return null;
      var s = 0; for (var j = i - p + 1; j <= i; j++) s += cl[j]; return s / p;
    };
    var e20 = emaSeries(cl, 20), e50 = emaSeries(cl, 50), e200 = emaSeries(cl, Math.min(200, n - 1));
    var s50 = [], s200 = [];
    for (var m = 0; m < n; m++) { s50[m] = smaWin(m, 50); s200[m] = smaWin(m, 200); }
    var i = n - 1, px = cl[i];
    var crossOf = function (A, B, span) {
      for (var k = i; k > i - span && k > 0; k--) {
        if (A[k] == null || B[k] == null || A[k - 1] == null || B[k - 1] == null) return null;
        if ((A[k] > B[k]) !== (A[k - 1] > B[k - 1])) return { dir: A[k] > B[k] ? 'bull' : 'bear', age: i - k };
      }
      return null;
    };
    var gc = crossOf(s50, s200, 60);
    if (gc) gc.name = gc.dir === 'bull' ? 'golden cross' : 'death cross';
    var ec = crossOf(e20, e50, 30);
    var bull = px > e20[i] && e20[i] > e50[i] && (e200[i] == null || e50[i] > e200[i]);
    var bear = px < e20[i] && e20[i] < e50[i] && (e200[i] == null || e50[i] < e200[i]);
    // ribbon fanning — all three EMAs sloping the same way means the stack
    // is expanding (trend acceleration); opposing slopes = churn/range
    var slopeOf = function (S, k) { return S[i] != null && S[i - k] != null ? S[i] - S[i - k] : 0; };
    var s20 = slopeOf(e20, 5), s50 = slopeOf(e50, 8), s200v = e200[i] != null ? slopeOf(e200, 12) : 0;
    var fanning = bull && s20 > 0 && s50 > 0 && s200v >= 0 ? 'bull'
               : bear && s20 < 0 && s50 < 0 && s200v <= 0 ? 'bear' : null;
    return {
      dir: bull ? 'bull' : bear ? 'bear' : null, aligned: bull || bear, fanning: fanning,
      ema20: e20[i], ema50: e50[i], ema200: e200[i] != null ? e200[i] : null,
      sma50: s50[i], sma200: s200[i],
      golden: gc, eCross: ec,
      label: (bull ? 'bull stack' : bear ? 'bear stack' : 'mixed stack')
        + (fanning ? ' · fanning' : '')
        + ' · px ' + (px > e20[i] ? '>' : '<') + ' E20 ' + (e20[i] > e50[i] ? '>' : '<') + ' E50'
        + (ec ? ' · ' + ec.dir + ' E20/50 cross ' + ec.age + 'b' : '')
        + (gc ? ' · ' + gc.name + ' ' + gc.age + 'b' : '')
    };
  }

  // ---------- chart patterns from zigzag pivots — the named geometry:
  // double/triple tops+bottoms, head & shoulders, triangles, wedges,
  // channels, rectangles, broadening formations, flags ----------
  function chartPats(cs) {
    var piv = zigzag(cs, 0.015);
    if (!piv || piv.length < 4) return [];
    var px = function (x) { return x >= 100 ? x.toFixed(1) : x >= 1 ? x.toFixed(3) : x.toPrecision(3); };
    var H = piv.filter(function (p) { return p.type === 'H'; }).slice(-4);
    var L = piv.filter(function (p) { return p.type === 'L'; }).slice(-4);
    var out = [];
    // triple-tops AND triple-bottoms coexisting = a rectangle, not two
    // reversals — demote both to plain doubles and let the box carry it.
    // Three touches = one band: the OLD check chained pairwise tolerance
    // (h3≈h2 AND h1≈h2) which let the outer peaks sit ~2×tol apart — a
    // sloped line still named 'triple top'.
    var band3 = function (ps) {
      var mn = Infinity, mx = -Infinity, sum = 0;
      for (var k = 0; k < ps.length; k++) { mn = Math.min(mn, ps[k].p); mx = Math.max(mx, ps[k].p); sum += ps[k].p; }
      return (mx - mn) / (sum / ps.length);
    };
    var topFlat = H.length >= 3 && band3(H.slice(-3)) <= 0.02;
    var botFlat = L.length >= 3 && band3(L.slice(-3)) <= 0.02;
    var dHv = H.length >= 2 ? Math.abs(H[H.length - 1].p - H[H.length - 2].p) / H[H.length - 2].p : 9;
    var dLv = L.length >= 2 ? Math.abs(L[L.length - 1].p - L[L.length - 2].p) / L[L.length - 2].p : 9;
    var bothTrip = topFlat && botFlat && dHv <= 0.03 && dLv <= 0.03;
    if (H.length >= 2) {
      var h1 = H[H.length - 1], h2 = H[H.length - 2], dH = dHv;
      var tr3 = topFlat && !bothTrip;
      if (dH <= 0.03) out.push({ name: tr3 ? 'triple top' : 'double top', dir: 'SHORT', conf: dH <= 0.01 ? 'B' : 'C', s: (tr3 ? 'triple' : 'twin') + ' highs ~' + px(h2.p) });
    }
    if (L.length >= 2) {
      var l1 = L[L.length - 1], l2 = L[L.length - 2], dL = dLv;
      var trB = botFlat && !bothTrip;
      if (dL <= 0.03) out.push({ name: trB ? 'triple bottom' : 'double bottom', dir: 'LONG', conf: dL <= 0.01 ? 'B' : 'C', s: (trB ? 'triple' : 'twin') + ' lows ~' + px(l2.p) });
    }
    if (H.length >= 3) {
      var a = H[H.length - 3], b = H[H.length - 2], c = H[H.length - 1];
      if (b.p > a.p && b.p > c.p && Math.abs(a.p - c.p) / a.p <= 0.06)
        out.push({ name: 'head & shoulders', dir: 'SHORT', conf: 'B', s: 'head ' + px(b.p) + ' shoulders ' + px(a.p) + '/' + px(c.p) });
    }
    if (L.length >= 3) {
      var a2 = L[L.length - 3], b2 = L[L.length - 2], c2 = L[L.length - 1];
      if (b2.p < a2.p && b2.p < c2.p && Math.abs(a2.p - c2.p) / a2.p <= 0.06)
        out.push({ name: 'inverse H&S', dir: 'LONG', conf: 'B', s: 'head ' + px(b2.p) + ' shoulders ' + px(a2.p) + '/' + px(c2.p) });
    }
    if (H.length >= 2 && L.length >= 2) {
      var hh2 = H[H.length - 2], hh1 = H[H.length - 1], ll2 = L[L.length - 2], ll1 = L[L.length - 1];
      var hFlat = Math.abs(hh1.p - hh2.p) / hh2.p <= 0.012, lFlat = Math.abs(ll1.p - ll2.p) / ll2.p <= 0.012;
      var hDn = hh1.p < hh2.p && !hFlat, lUp = ll1.p > ll2.p && !lFlat;
      var hUp = hh1.p > hh2.p && !hFlat, lDn = ll1.p < ll2.p && !lFlat;
      if (hFlat && lFlat) out.push({ name: 'rectangle range', dir: null, conf: 'C', s: 'box ' + px(ll1.p) + '–' + px(hh1.p) });
      else if (hDn && lUp) out.push({ name: 'sym triangle', dir: null, conf: 'C', s: 'coiling — apex break pending' });
      else if (hUp && lUp) out.push({ name: 'rising channel', dir: 'LONG', conf: 'C', s: 'parallel rising structure' });
      else if (hDn && lDn) out.push({ name: 'falling channel', dir: 'SHORT', conf: 'C', s: 'parallel falling structure' });
      else if (hUp && lDn) out.push({ name: 'broadening', dir: null, conf: 'C', s: 'expanding volatility — megaphone' });
      else if (!hDn && lUp) out.push({ name: 'rising wedge', dir: 'SHORT', conf: 'C', s: 'rising compression — bearish lean' });
      else if (hDn && !lUp) out.push({ name: 'falling wedge', dir: 'LONG', conf: 'C', s: 'falling compression — bullish lean' });
    }
    var n6 = cs.slice(-6), p6 = cs.slice(-14, -6);
    if (p6.length === 8 && n6.length === 6) {
      var imp = (p6[7].c - p6[0].o) / p6[0].o, drift = (n6[5].c - n6[0].o) / n6[0].o;
      if (imp > 0.025 && Math.abs(drift) < 0.012) out.push({ name: 'bull flag', dir: 'LONG', conf: 'B', s: '+' + (imp * 100).toFixed(1) + '% impulse then coil' });
      else if (imp < -0.025 && Math.abs(drift) < 0.012) out.push({ name: 'bear flag', dir: 'SHORT', conf: 'B', s: (imp * 100).toFixed(1) + '% impulse then coil' });
    }
    return out;
  }

  // ---------- breakout core: compression → expansion → retest lifecycle.
  // Levels are the 55-bar Donchian channel recomputed per bar; a break only
  // counts on a CLOSE beyond the level. Post-break bars tagging the broken
  // level (within 0.35 ATR) while price holds direction = retest — the
  // strongest entry pattern. Closing back inside = trap; the signal flips
  // because the failed break becomes fuel the other way. ----------
  function breakout(cs) {
    var n = cs.length; if (n < 60) return null;
    var atr = function (upto) {
      var s = 0, c = 0;
      for (var j = Math.max(1, upto - 13); j <= upto; j++) {
        var p = cs[j - 1];
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - p.c), Math.abs(cs[j].l - p.c)); c++;
      }
      return c ? s / c : 1e-9;
    };
    var A = atr(n - 1);
    var dc = function (i) {
      var h = -Infinity, l = Infinity;
      for (var j = Math.max(0, i - 55); j < i; j++) { if (cs[j].h > h) h = cs[j].h; if (cs[j].l < l) l = cs[j].l; }
      return { h: h, l: l };
    };
    var now = dc(n - 1);
    var h8 = -Infinity, l8 = Infinity;
    for (var j = n - 8; j < n; j++) { if (cs[j].h > h8) h8 = cs[j].h; if (cs[j].l < l8) l8 = cs[j].l; }
    var coil = now.h - now.l > 0 ? (h8 - l8) / (now.h - now.l) : 1;
    var avgV = 0, vc = 0;
    for (var j = n - 25; j < n - 1; j++) if (cs[j].qv > 0) { avgV += cs[j].qv; vc++; }
    avgV = vc ? avgV / vc : 0;
    var brk = null;
    for (var i = n - 1; i > n - 15 && i > 0; i--) {
      var d = dc(i);
      if (cs[i].c > d.h) { brk = { i: i, dir: 'bull', level: d.h }; break; }
      if (cs[i].c < d.l) { brk = { i: i, dir: 'bear', level: d.l }; break; }
    }
    var state = null, volX = null, failed = false;
    if (brk) {
      var age = n - 1 - brk.i;
      volX = avgV > 0 && cs[brk.i].qv ? +(cs[brk.i].qv / avgV).toFixed(2) : null;
      var beyond = brk.dir === 'bull' ? cs[n - 1].c > brk.level : cs[n - 1].c < brk.level;
      var touched = false;
      for (var j2 = brk.i + 1; j2 < n; j2++) {
        var px2 = brk.dir === 'bull' ? cs[j2].l : cs[j2].h;
        if (Math.abs(px2 - brk.level) <= 0.35 * A) touched = true;
      }
      if (!beyond) { state = 'FAILED'; failed = true; }
      else if (touched && age > 0) state = 'RETEST';
      else state = 'BREAKOUT';
      if (failed) brk.dir = brk.dir === 'bull' ? 'bear' : 'bull';
    } else if (coil <= 0.35) state = 'COMPRESSION';
    var rangeH = now.h - now.l;
    var target = brk ? (brk.dir === 'bull' ? brk.level + rangeH : brk.level - rangeH) : null;
    var pv = function (x) { return x >= 100 ? x.toFixed(1) : x >= 1 ? x.toFixed(3) : x.toPrecision(3); };
    return {
      dir: brk ? brk.dir : null, state: state, level: brk ? brk.level : null,
      age: brk ? n - 1 - brk.i : null, volX: volX, coil: +coil.toFixed(2),
      dcH: now.h, dcL: now.l, target: target, failed: failed,
      label: brk
        ? state + ' ' + brk.dir.toUpperCase() + ' @ ' + pv(brk.level) + ' · ' + (n - 1 - brk.i) + 'b ago'
          + (volX ? ' · ' + volX + '× vol' : '') + (target ? ' · tgt ' + pv(target) : '')
        : state === 'COMPRESSION' ? 'coiled — last-8 range ' + Math.round(coil * 100) + '% of 55b' : 'no break, no coil'
    };
  }

  // ---------- ENGINE: effort vs result (Wyckoff's 2nd law) ----------
  // High effort (volume) producing low result (range) at an edge means the
  // aggressive side is being absorbed — composite-man tell. At range lows:
  // sellers working hard but price can't fall = accumulation under cover.
  // At highs: buyers straining, price won't rise = distribution supply.
  // Drive bars (effort AND result both expanded) confirm initiative flow.
  function effortResult(cs) {
    var n = cs.length; if (n < 40) return null;
    var refV = 0, refR = 0, cnt = 0;
    for (var i = n - 42; i < n - 12; i++) if (i >= 0) { refV += cs[i].qv || 0; refR += cs[i].h - cs[i].l; cnt++; }
    if (!cnt || !refV) return null;
    refV /= cnt; refR /= cnt;
    var lo = 1e18, hi = -1e18;
    for (var j = n - 12; j < n; j++) { lo = Math.min(lo, cs[j].l); hi = Math.max(hi, cs[j].h); }
    var span = hi - lo || 1e-9;
    var absorb = 0, supply = 0, driveBull = 0, driveBear = 0;
    for (var k = n - 12; k < n - 1; k++) {
      var c = cs[k], effort = (c.qv || 0) / refV, result = (c.h - c.l) / (refR || 1e-9);
      var nearLo = c.l <= lo + span * 0.25, nearHi = c.h >= hi - span * 0.25;
      if (effort >= 1.6 && result <= 0.75) {
        if (nearLo) absorb++; else if (nearHi) supply++;
      } else if (effort >= 1.5 && result >= 1.5) {
        if (c.c >= c.o) driveBull++; else driveBear++;
      }
    }
    var dir = absorb >= 2 ? 'bull' : supply >= 2 ? 'bear'
            : driveBull - driveBear >= 2 ? 'bull' : driveBear - driveBull >= 2 ? 'bear' : null;
    var strength = Math.min(1, (absorb + supply) / 4 + Math.abs(driveBull - driveBear) / 8);
    return { dir: dir, absorb: absorb, supply: supply, drive: driveBull - driveBear,
             strength: +strength.toFixed(2),
             label: absorb >= 2 ? absorb + ' absorption bars at lows — sellers absorbed'
                  : supply >= 2 ? supply + ' supply bars at highs — buyers absorbed'
                  : Math.abs(driveBull - driveBear) >= 2 ? (driveBull > driveBear ? 'bull' : 'bear') + ' drive ' + Math.abs(driveBull - driveBear) + ' bars'
                  : 'effort matches result — no imbalance' };
  }

  // ---------- ENGINE: Elliott forward projection ----------
  // The completed-W5 detector marks tops/bottoms. This engine finds the
  // IMPULSE STILL RUNNING: trailing pivots X-W1-W2-W3-W4 with hard rules
  // checked (W2 holds X, W4 no overlap into W1, W3 not shortest), then
  // projects W5 targets on the standard Fib extensions and reports the
  // invalidation level — Elliott as hypothesis with a kill-switch, not dogma.
  function elliottProj(cs) {
    if (!zigzag || cs.length < 30) return null;
    var piv = zigzag(cs, 0.02);
    if (piv.length < 5) return null;
    var p = piv.slice(-5), seq = p.map(function (x) { return x.type; }).join('');
    var up = seq === 'LHLHL', dn = seq === 'HLHLH';
    if (!up && !dn) return null;
    var X = p[0].p, W1 = p[1].p, W2 = p[2].p, W3 = p[3].p, W4 = p[4].p;
    var w1 = Math.abs(W1 - X), w3 = Math.abs(W3 - W2), w13 = Math.abs(W3 - X);
    var w4r = Math.abs(W3 - W4) / (w3 || 1e-9), w2r = Math.abs(W1 - W2) / (w1 || 1e-9);
    var ok = up ? (W2 > X * 0.995 && W4 > W1 * 0.99 && w3 >= w1 * 0.9 && w2r > 0.236 && w2r < 0.9 && w4r > 0.1 && w4r < 0.62)
              : (W2 < X * 1.005 && W4 < W1 * 1.01 && w3 >= w1 * 0.9 && w2r > 0.236 && w2r < 0.9 && w4r > 0.1 && w4r < 0.62);
    if (!ok) return null;
    // W5 projections: 0.618×W1-3 net, and 1.0×W1 from W4 — report the band
    var tA = up ? W4 + w13 * 0.618 : W4 - w13 * 0.618,
        tB = up ? W4 + w1 * 1.0 : W4 - w1 * 1.0;
    var lastC = cs[cs.length - 1].c;
    var age = cs.length - 1 - p[4].i;
    var live = up ? lastC < Math.max(tA, tB) * 1.005 : lastC > Math.min(tA, tB) * 0.995;
    return { dir: up ? 'bull' : 'bear', inW5: true, complete: false,
             targetLo: +Math.min(tA, tB).toFixed(8), targetHi: +Math.max(tA, tB).toFixed(8),
             invalid: up ? +W1.toFixed(8) : +W1.toFixed(8),
             live: live, age: age,
             ratios: { w2r: +w2r.toFixed(3), w4r: +w4r.toFixed(3) },
             label: 'W5 ' + (up ? 'up' : 'down') + ' in progress · tgt ' +
                    (up ? Math.min(tA, tB).toPrecision(4) + '–' + Math.max(tA, tB).toPrecision(4)
                        : Math.min(tA, tB).toPrecision(4) + '–' + Math.max(tA, tB).toPrecision(4)) +
                    ' · invalid <' + (up ? '>' : '') + ' W1 ' + W1.toPrecision(4) };
  }

  function analyze(cs, cs5m, extra) {
    if (!cs || cs.length < 20 || !zigzag) return null;
    var s = sfp(cs), f = fvgs(cs), e = elliott(cs), w = wyckoff(cs),
        cd = candlesticks(cs), fb = fib(cs), st = structure(cs), ig = ignition(cs),
        mc = smc(cs), eq = eqLevels(cs), lq = liquidity(cs),
        ichi = ichimoku(cs), mas = maStack(cs), cps = chartPats(cs),
        brk = breakout(cs), er = effortResult(cs), ep = elliottProj(cs),
        vw = vwap(cs5m && cs5m.length >= 24 ? cs5m : cs, cs5m && cs5m.length >= 24 ? 288 : 24);
    // bias: a graded liquidity sweep leads (TTC — the pool raid IS the
    // signal), then SFP, completed W5, wyckoff event, smc choch, then
    // ignition — each lower rung only fires when the stronger ones are silent
    var bias = null, reasons = [];
    if (lq && lq.setup && lq.setup.grade !== 'C') {
      bias = lq.setup.dir; reasons.push('liq-sweep');
    }
    else if (s) { bias = s.type === 'bullish' ? 'LONG' : 'SHORT'; reasons.push('sfp'); }
    else if (e && e.complete && cs.length - 1 - e.dIdx <= 10) {
      bias = e.shortTop ? 'SHORT' : 'LONG'; reasons.push('elliott-w5');
    } else if (w && w.event) { bias = w.bias; reasons.push('wyckoff-' + w.event.toLowerCase()); }
    else if (mc && mc.choch) { bias = mc.choch === 'bullish' ? 'LONG' : 'SHORT'; reasons.push('smc-choch'); }
    else if (mc && mc.bos) { bias = mc.bos === 'bullish' ? 'LONG' : 'SHORT'; reasons.push('smc-bos'); }
    else if (ig) { bias = ig.dir; reasons.push('ignition'); }
    else if (vw && vw.stretched) { bias = vw.fade; reasons.push('vwap-reversion'); }
    else if (ep && ep.live) { bias = ep.dir === 'bull' ? 'LONG' : 'SHORT'; reasons.push('elliott-w5-proj'); }
    else if (er && er.dir && er.strength >= 0.5) { bias = er.dir === 'bull' ? 'LONG' : 'SHORT'; reasons.push('effort-result'); }
    else if (eq && eq.lean) { bias = eq.lean; reasons.push('eq-edge'); }
    // sub-engines: RSI/MACD/OBV/Dow/trends/reversal/MTF — confirmation layer
    var eng = {
      rsi: rsiEng(cs), macd: macdEng(cs), obv: obvEng(cs), dow: dowEng(cs),
      minor: trendOf(cs.slice(-18), 0.008), major: trendOf(cs, 0.02),
      macro: trendOf(agg(cs, 4), 0.02), superMacro: trendOf(agg(cs, 8), 0.025),
      mtf: mtfEng(cs), ichi: ichi, mas: mas, brk: brk,
    };
    eng.rev = revEng(cs, { sfp: s, mc: mc, w: w, eng: eng });
    if (eng.minor) eng.minor.label = 'minor trend (18b): ' + eng.minor.trend;
    if (eng.major) eng.major.label = 'major trend (window): ' + eng.major.trend;
    if (eng.macro) eng.macro.label = 'macro (4h): ' + eng.macro.trend;
    if (eng.superMacro) eng.superMacro.label = 'super-macro (12h): ' + eng.superMacro.trend;
    var confluence = 0;
    if (bias) {
      var L = bias === 'LONG';
      if (lq && lq.setup && lq.setup.dir === bias) confluence++;
      if (lq && ((lq.zone === 'discount') === L) && lq.zone !== 'equilibrium') confluence++;
      if (lq && lq.targetPx && lq.targetDistPct >= 1 && lq.targetDistPct <= 8) confluence++;
      if (lq && lq.inducement) confluence--; // minor pool in the way — may stop-run first
      if (s && (s.type === 'bullish') === L) confluence++;
      if (e && ((e.shortTop) === !L)) confluence++;
      if (w && w.bias === bias) confluence++;
      if (w && w.quality >= 70) confluence++;            // confirmed wyckoff event
      if (L && w && w.springHold === true) confluence++; // spring holding above support
      if (!L && w && w.uthrHold === true) confluence++;  // upthrust holding below resist
      if (ep && ep.live && ep.dir === (L ? 'bull' : 'bear')) confluence++;
      if (er && er.dir === (L ? 'bull' : 'bear')) confluence++;
      if (mas && mas.fanning === (L ? 'bull' : 'bear')) confluence++;
      if (mc && ((mc.bos === 'bullish') === L || (mc.choch === 'bullish') === L)) confluence++;
      if (mc && mc.inOB && (mc.inOB.dir === 'bullish') === L) confluence++;
      if (mc && ((mc.zone === 'discount') === L) && mc.zone !== 'equilibrium') confluence++;
      if (eq && eq.lean === bias) confluence++;
      if (eq && (L ? eq.rangeQ === 'Q1-discount' : eq.rangeQ === 'Q4-premium')) confluence++;
      if (ig && ig.dir === bias) confluence++;
      if (vw && vw.fade === bias) confluence++;
      if (st.trend === (L ? 'up' : 'down')) confluence++;
      if (fb && fb.goldenPocket) confluence++;
      if (cd.some(function (x) { return (x.indexOf('bull') === 0 || x === 'hammer' || x === 'morning star') === L; })) confluence++;
      // engine votes — bounded so confirmations can't swamp primary signals
      var ev = 0;
      ['rsi', 'macd', 'obv', 'dow', 'rev', 'ichi', 'mas', 'brk'].forEach(function (k) {
        var x = eng[k]; if (x && x.dir && (x.dir === 'bull') === L) ev++;
      });
      if (eng.mtf && eng.mtf.aligned && eng.mtf.dir === (L ? 'bull' : 'bear')) ev++;
      confluence += Math.min(4, ev);
      // named chart geometry aligning with the primary bias
      if (cps && cps.some(function (x) { return x.dir === bias; })) confluence++;
    }
    // 14-period true-range % of price — the noise floor a stop must clear
    var atrSum = 0, atrN = 0;
    for (var ai = Math.max(1, cs.length - 15); ai < cs.length; ai++) {
      var ac = cs[ai], ap = cs[ai - 1];
      atrSum += Math.max(ac.h - ac.l, Math.abs(ac.h - ap.c), Math.abs(ac.l - ap.c));
      atrN++;
    }
    var atrPct = atrN ? +(atrSum / atrN / cs[cs.length - 1].c * 100).toFixed(3) : null;
    // ---- factors ledger: every input, its direction vote, and the evidence
    // string — this is the "what led to the signal" trail the dashboard and
    // journal render. dir: bull | bear | flat (no directional read)
    var factors = [];
    var F = function (k, d, s) { factors.push({ k: k, dir: d, s: s }); };
    var LD = function (x) { return x === 'LONG' ? 'bull' : x === 'SHORT' ? 'bear' : 'flat'; };
    F('BIAS', LD(bias), reasons.join(' + ') || 'no primary trigger — standalone engine reads only');
    if (lq) F('liquidity', lq.setup ? LD(lq.setup.dir) : lq.zone === 'discount' ? 'bull' : lq.zone === 'premium' ? 'bear' : 'flat',
      (lq.setup ? lq.setup.grade + '-grade sweep → ' : '') + (lq.zone || '?') + ' zone' + (lq.targetDistPct ? ' · draw ' + lq.targetDistPct + '% away' : ''));
    if (s) F('SFP', s.type === 'bullish' ? 'bull' : 'bear', s.type + ' sweep of ' + (s.level != null ? s.level : '?') + ' · str ' + s.strength);
    if (e && e.complete) F('elliott', e.shortTop ? 'bear' : e.longBottom ? 'bull' : 'flat', 'wave-5 complete · q' + (e.quality ?? '?'));
    if (ep && ep.live) F('EW proj', ep.dir === 'bull' ? 'bull' : 'bear', ep.label);
    if (w && w.event) F('wyckoff', LD(w.bias), (w.event || '?') + ' · phase ' + (w.phase || '?') + ' · q' + w.quality
      + (w.springHold === true ? ' · spring holding' : w.uthrHold === true ? ' · UTAD holding' : '')
      + (w.target ? ' · tgt ' + (+w.target).toPrecision(4) : ''));
    if (er && (er.dir || er.absorb || er.supply)) F('effort/result', er.dir || 'flat', er.label);
    if (mc && (mc.bos || mc.choch)) F('SMC', mc.choch === 'bullish' || mc.bos === 'bullish' ? 'bull' : mc.choch === 'bearish' || mc.bos === 'bearish' ? 'bear' : 'flat',
      (mc.choch ? 'CHoCH ' + mc.choch : 'BOS ' + mc.bos) + ' · ' + (mc.zone || '?'));
    if (eq && (eq.lean || eq.rangeQ)) F('EQ', LD(eq.lean), (eq.rangeQ || '?') + ' · pos ' + Math.round((eq.rangePos || 0) * 100) + '%');
    if (ig) F('ignition', LD(ig.dir), 'range ' + ig.rangeX + '× · vol ' + ig.volX + '×');
    if (vw && vw.stretched) F('VWAP', LD(vw.fade), 'z ' + vw.z + ' · dev ' + vw.devPct + '%');
    F('structure', st.trend === 'up' ? 'bull' : st.trend === 'down' ? 'bear' : 'flat',
      st.trend + ' · ' + st.hh + 'H ' + st.hl + 'HL / ' + st.lh + 'LH ' + st.ll + 'LL');
    if (fb && fb.goldenPocket) F('fib', 'bull', 'golden pocket · ' + fb.clusters + ' cluster(s)');
    else if (fb && fb.clusters) F('fib', 'flat', fb.clusters + ' fib cluster(s) nearby');
    if (cd && cd.length) {
      var cb = cd.filter(function (x) { return x.indexOf('bull') === 0 || x === 'hammer' || x === 'morning star'; }),
          cr = cd.filter(function (x) { return x.indexOf('bull') !== 0 && x !== 'hammer' && x !== 'morning star'; });
      F('candles', cb.length > cr.length ? 'bull' : cr.length > cb.length ? 'bear' : 'flat', cd.join(', '));
    }
    if (cps && cps.length) cps.forEach(function (p) { F('pattern', LD(p.dir) , p.name + ' (' + p.conf + ') — ' + p.s); });
    // deep MTF frames — per-timeframe factor rows so each TF's vote is
    // individually auditable (and Einstein can IC-test them separately)
    var mtd = extra && extra.mtf;
    if (mtd && mtd.cells) {
      (mtd.frames || []).forEach(function (tf) {
        var c = mtd.cells[tf];
        if (c) F('MTF ' + tf, c.dir || 'flat', c.label);
      });
      F('MTF stack', mtd.dir || 'flat', mtd.stack + ' — ' + mtd.agree + '/' + mtd.n + ' frames agree');
    }
    var EG = { rsi: 'RSI', macd: 'MACD', obv: 'OBV', dow: 'Dow', ichi: 'Ichimoku', mas: 'MA stack', brk: 'breakout', rev: 'reversal', mtf: 'MTF' };
    for (var ek in EG) { var x2 = eng[ek]; if (x2) F(EG[ek], x2.dir || 'flat', x2.label || ''); }
    if (eng.minor) F('minor tr', eng.minor.trend === 'up' ? 'bull' : eng.minor.trend === 'down' ? 'bear' : 'flat', eng.minor.trend);
    if (eng.macro) F('macro tr', eng.macro.trend === 'up' ? 'bull' : eng.macro.trend === 'down' ? 'bear' : 'flat', eng.macro.trend);
    if (eng.superMacro) F('smacro', eng.superMacro.trend === 'up' ? 'bull' : eng.superMacro.trend === 'down' ? 'bear' : 'flat', eng.superMacro.trend);
    F('confluence', 'flat', confluence + ' aligned votes');
    return { sfp: s, fvgs: f.slice(0, 4), elliott: e, wyckoff: w,
             candles: cd, fib: fb, structure: st, ignition: ig, vwap: vw,
             smc: mc, eq: eq, eng: eng, liquidity: lq, atrPct: atrPct,
             ichi: ichi, mas: mas, cps: cps, brk: brk, factors: factors,
             effort: er, ewProj: ep,
             mtf: mtd,
             bias: bias, reasons: reasons, confluence: confluence };
  }

  g.TAEngine = { analyze: analyze, sfp: sfp, fvgs: fvgs, elliott: elliott,
                 wyckoff: wyckoff, candlesticks: candlesticks, fib: fib,
                 structure: structure, ignition: ignition, keyLevels: keyLevels,
                 vwap: vwap, smc: smc, eqLevels: eqLevels, liquidity: liquidity,
                 rsiEng: rsiEng, macdEng: macdEng, obvEng: obvEng, dowEng: dowEng,
                 mtfEng: mtfEng, mtfDeep: mtfDeep, revEng: revEng,
                 effortResult: effortResult, elliottProj: elliottProj };
  if (typeof module !== 'undefined' && module.exports) module.exports = g.TAEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
