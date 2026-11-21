'use strict';
/* ALPHA — core simulation. Pure logic, no DOM.
   Runs in browser (window.Sim) and Node (module.exports). */
(function (global) {

  // ---------- RNG ----------
  function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
      t += 0x6D2B79F5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeRng(seed) {
    const r = mulberry32(seed);
    const gauss = () => {
      let u = 0, v = 0;
      while (u === 0) u = r();
      while (v === 0) v = r();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    return {
      next: r,
      range: (a, b) => a + r() * (b - a),
      int: (a, b) => Math.floor(a + r() * (b - a + 1)),
      pick: (arr) => arr[Math.floor(r() * arr.length)],
      gauss,
    };
  }
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  // ---------- Market definition ----------
  // beta: directional sensitivity to regime drift. volScale: vol multiplier vs regime.
  // minVol: daily vol floor. lowerBeta instruments hedge in risk-off.
  const INSTRUMENTS = {
    SPX:  { name: 'SPX Index',  base: 100,    beta: 1.0,  volScale: 1.0,  minVol: 0.005, color: '#4fc3f7' },
    BTC:  { name: 'BTC/USD',    base: 60000,  beta: 1.7,  volScale: 1.9,  minVol: 0.014, color: '#f7931a' },
    GOLD: { name: 'Gold',       base: 2000,   beta: 0.2,  volScale: 0.8,  minVol: 0.004, color: '#ffd54f' },
    BOND: { name: 'Bond Index', base: 100,    beta: -0.8, volScale: 0.5,  minVol: 0.003, color: '#81c784' },
    OIL:  { name: 'Crude Oil',  base: 75,     beta: 0.6,  volScale: 0.9,  minVol: 0.006, color: '#ff8a65' },
    MEME: { name: 'MEME/USD',   base: 0.5,    beta: 2.6,  volScale: 2.6,  minVol: 0.022, color: '#e879f9' },
  };

  const REGIMES = {
    RISK_ON:  { drift: 0.0016, vol: 0.006, jumpProb: 0.02, jump: 0.010, dur: [15, 45], shock: 0.015, label: 'RISK ON' },
    RANGE:    { drift: 0.0000, vol: 0.004, jumpProb: 0.01, jump: 0.006, dur: [15, 50], shock: 0.000, label: 'RANGE' },
    RISK_OFF: { drift: -0.0022, vol: 0.009, jumpProb: 0.04, jump: 0.014, dur: [10, 35], shock: -0.020, label: 'RISK OFF' },
    PANIC:    { drift: -0.0050, vol: 0.022, jumpProb: 0.10, jump: 0.030, dur: [ 4, 14], shock: -0.045, label: 'PANIC' },
    EUPHORIA: { drift: 0.0040, vol: 0.013, jumpProb: 0.07, jump: 0.022, dur: [ 6, 18], shock: 0.025, label: 'EUPHORIA' },
  };
  const REGIME_KEYS = Object.keys(REGIMES);
  // Transition weights — PANIC is rare but deadly, EUPHORIA tempting.
  const REGIME_WEIGHTS = { RISK_ON: 0.24, RANGE: 0.24, RISK_OFF: 0.22, PANIC: 0.13, EUPHORIA: 0.17 };

  // ---------- Strategies ----------
  // Each returns a target exposure pos in [-1,1] for its instrument, except CARRY
  // which is a synthetic short-vol carry position.
  const STRATEGIES = {
    MOMENTUM: {
      name: 'Momentum',
      desc: 'Long/flat/short on trailing return. Eats trends, bleeds in chop.',
      param: { key: 'lookback', label: 'Lookback (days)', min: 5, max: 60, def: 20, step: 1 },
    },
    MEAN_REV: {
      name: 'Mean Reversion',
      desc: 'Fades z-score extremes vs rolling mean. Wins in ranges, dies in trends.',
      param: { key: 'window', label: 'Window (days)', min: 10, max: 90, def: 30, step: 1 },
    },
    CARRY: {
      name: 'Carry (short vol)',
      desc: 'Harvests steady premium, gets run over by crashes. Picks up pennies.',
      param: null,
    },
    SENTIMENT: {
      name: 'Sentiment',
      desc: 'Front-runs news flow with decay. Spiky around events, flat otherwise.',
      param: { key: 'decay', label: 'Decay (days)', min: 2, max: 20, def: 10, step: 1 },
    },
    BREAKOUT: {
      name: 'Breakout',
      desc: 'Flat until price clears the N-day range, then rides the break. Dies on fake-outs.',
      param: { key: 'window', label: 'Window (days)', min: 5, max: 60, def: 20, step: 1 },
    },
  };
  const FEE_RATE = 0.00005;     // 0.5 bps per unit of turnover (position change + rebalance)
  const CASH_RATE = 0.0002;     // ~5%/yr on unallocated cash
  const RUIN_FRACTION = 0.5;    // book equity below 50% of start = liquidated
  const DEAD_FLOOR = 500;       // slot equity below this = dead, never refilled

  function sentimentImpact(regime) {
    return { RISK_ON: 0.8, EUPHORIA: 1.4, RANGE: 0, RISK_OFF: -1.0, PANIC: -1.8 }[regime] || 0;
  }

  // ---------- Event table ----------
  // regime forces the tape for `dur` days and adds an immediate shock.
  const EVENT_TABLE = [
    { text: 'CPI prints hot — rate path reprices higher', regime: 'RISK_OFF', dur: [6, 12] },
    { text: 'Central bank cuts rates, guidance dovish', regime: 'RISK_ON', dur: [8, 16] },
    { text: 'Exchange halts withdrawals — contagion fears', regime: 'PANIC', dur: [4, 8] },
    { text: 'Megacap earnings beat across the board', regime: 'EUPHORIA', dur: [6, 14] },
    { text: 'Geopolitical escalation — supply shock risk', regime: 'PANIC', dur: [5, 10] },
    { text: 'Inflation cools faster than expected', regime: 'RISK_ON', dur: [7, 14] },
    { text: 'Credit stress emerges in regional banks', regime: 'RISK_OFF', dur: [6, 12] },
    { text: 'ETF inflows surge to record weekly high', regime: 'EUPHORIA', dur: [5, 12] },
    { text: 'Flash crash in crypto markets', regime: 'PANIC', dur: [3, 7] },
    { text: 'Surprise rate hike — liquidity drains', regime: 'PANIC', dur: [5, 11] },
    { text: 'Short squeeze — dealers unwind', regime: 'EUPHORIA', dur: [4, 9] },
    { text: 'Liquidity drain — depth evaporates', regime: 'RISK_OFF', dur: [6, 13] },
    { text: 'Momentum unwind — quant deleveraging', regime: 'RISK_OFF', dur: [4, 9] },
    { text: 'Risk-on rotation — breadth expands', regime: 'RISK_ON', dur: [8, 18] },
  ];

  function defaultSlots() {
    return [
      { instrument: 'SPX', strategy: 'MOMENTUM', param: 20, ddLimit: 0.15, alloc: 0.25, lev: 1 },
      { instrument: 'BOND', strategy: 'MEAN_REV', param: 30, ddLimit: 0.12, alloc: 0.25, lev: 1 },
      { instrument: 'GOLD', strategy: 'CARRY', param: 0, ddLimit: 0.10, alloc: 0.25, lev: 1 },
      { instrument: 'BTC', strategy: 'SENTIMENT', param: 7, ddLimit: 0.18, alloc: 0.25, lev: 1 },
    ];
  }

  // ---------- Strategy signals ----------
  // hist = array of {p, r} through yesterday (today not yet pushed).
  function signalMomentum(hist, lookback) {
    const L = Math.min(lookback, hist.length - 1);
    if (L < 3 || hist.length < L + 1) return 0;
    const p0 = hist[hist.length - 1 - L].p;
    const p1 = hist[hist.length - 1].p;
    if (!p0) return 0;
    const retL = p1 / p0 - 1;
    // t-stat style: scale the L-day return by its own volatility. Only trades
    // when the trend is statistically meaningful — flat in chop.
    let m = 0;
    const n = Math.min(L, hist.length - 1);
    for (let i = hist.length - 1 - n; i < hist.length; i++) m += hist[i].r;
    m /= Math.max(1, n);
    let v = 0;
    for (let i = hist.length - 1 - n; i < hist.length; i++) v += (hist[i].r - m) * (hist[i].r - m);
    const sdL = Math.sqrt(v / Math.max(1, n)) * Math.sqrt(L) || 1e-9;
    const t = retL / sdL;
    return clamp(t / 1.5, -1, 1);
  }

  function signalMeanRev(hist, window) {
    const W = Math.min(window, hist.length);
    if (W < 10) return 0;
    const seg = hist.slice(-W);
    const logs = new Array(W);
    let m = 0;
    for (let i = 0; i < W; i++) { logs[i] = Math.log(seg[i].p); m += logs[i]; }
    m /= W;
    let v = 0;
    for (let i = 0; i < W; i++) v += (logs[i] - m) * (logs[i] - m);
    const sd = Math.sqrt(v / W) || 1e-9;
    const z = (logs[W - 1] - m) / sd;
    return clamp(-z / 1.25, -1, 1);
  }

  function carryReturn(instRet, vol10) {
    const carry = 0.0005; // ~13%/yr baseline premium when calm
    let pen = 0;
    if (instRet < -0.025) pen = (-instRet - 0.025) * 2.0; // crash convexity
    pen += Math.max(0, vol10 - 0.018) * 1.5;              // vol-regime bleed
    return clamp(carry - pen, -0.7, 0.25);
  }

  function signalSentiment(slot) {
    return clamp(Math.tanh(slot.mem / 1.0), -1, 1);
  }

  function signalBreakout(hist, window) {
    const W = Math.min(window, hist.length - 1);
    if (W < 5) return 0;
    let hi = -Infinity, lo = Infinity;
    // window excludes today — breakout = close beyond the PRIOR N-day range
    for (let i = hist.length - 1 - W; i < hist.length - 1; i++) {
      hi = Math.max(hi, hist[i].p);
      lo = Math.min(lo, hist[i].p);
    }
    const last = hist[hist.length - 1].p;
    if (last > hi) return 1;
    if (last < lo) return -1;
    return 0;
  }

  // ---------- Game ----------
  class Game {
    constructor(opts = {}) {
      this.seed = opts.seed != null ? opts.seed : Math.floor(Math.random() * 1e9);
      this.rng = makeRng(this.seed);
      this.maxDay = opts.maxDay || 120;
      this.startEquity = opts.startEquity || 1000000;
      this.day = 0;
      this.over = false;
      this.result = null;

      this.slots = (opts.slots || defaultSlots()).map((s) => ({
        instrument: s.instrument,
        strategy: s.strategy,
        param: s.param != null ? s.param : (STRATEGIES[s.strategy].param ? STRATEGIES[s.strategy].param.def : 0),
        ddLimit: s.ddLimit != null ? s.ddLimit : 0.15,
        alloc: s.alloc != null ? s.alloc : 0,
        lev: s.lev != null ? s.lev : 1,
        equity: 0,
        peak: 0,
        armed: true,
        dead: false,
        mem: 0,
        pos: 0,
        posPrev: null,
      }));
      this._normalizeAllocs();

      // Fund equity starts fully allocated across slots per alloc fractions.
      this.cash = 0;
      let assigned = 0;
      for (const s of this.slots) { s.equity = this.startEquity * s.alloc; s.peak = s.equity; assigned += s.equity; }
      this.cash = this.startEquity - assigned;

      this.regime = 'RANGE';
      this.regimeDays = this.rng.int(15, 40);
      this.event = null;
      this.eventTriggeredToday = false;
      this._scheduleEvents();

      this.prices = {};
      this.hist = {};
      for (const k of Object.keys(INSTRUMENTS)) {
        this.prices[k] = INSTRUMENTS[k].base * (1 + this.rng.range(-0.02, 0.02));
        this.hist[k] = [{ p: this.prices[k], r: 0 }];
      }

      this.log = [];
      this.equityHist = [{ day: 0, equity: this.bookEquity(), dd: 0, regime: this.regime }];
      this.peakEquity = this.startEquity;
      this.maxDD = 0;
      this._say('system', `Fund seeded. $${this.startEquity.toLocaleString()} across ${this.slots.length} strategy slots. ${this.maxDay}-day mandate.`);
    }

    _normalizeAllocs() {
      const sum = this.slots.reduce((a, s) => a + (s.dead ? 0 : s.alloc), 0);
      if (sum > 0.999) {
        const f = 0.999 / sum;
        for (const s of this.slots) s.alloc *= f;
      }
    }

    _scheduleEvents() {
      this.eventQueue = [];
      let d = this.rng.int(7, 13);
      const used = new Set();
      while (d < this.maxDay - 2) {
        let ev;
        do { ev = this.rng.pick(EVENT_TABLE); } while (used.has(ev) && used.size < EVENT_TABLE.length - 1);
        used.add(ev);
        this.eventQueue.push({ day: d, text: ev.text, regime: ev.regime, dur: this.rng.int(ev.dur[0], ev.dur[1]) });
        d += this.rng.int(7, 13);
      }
      this.eventQueue.sort((a, b) => a.day - b.day);
      // Story arc: guarantee a crisis in the back third — every run climaxes.
      const crisis = this.eventQueue.some((e) => (e.regime === 'PANIC' || e.regime === 'RISK_OFF') && e.day > this.maxDay - 30);
      if (!crisis) {
        const crisisEvents = EVENT_TABLE.filter((e) => e.regime === 'PANIC');
        const ev = this.rng.pick(crisisEvents);
        this.eventQueue.push({ day: this.rng.int(this.maxDay - 25, this.maxDay - 8), text: ev.text, regime: ev.regime, dur: this.rng.int(ev.dur[0], ev.dur[1]) });
        this.eventQueue.sort((a, b) => a.day - b.day);
      }
    }

    bookEquity() {
      return this.cash + this.slots.reduce((a, s) => a + s.equity, 0);
    }

    _say(type, text) {
      this.log.push({ day: this.day, type, text });
      if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
    }

    _effectiveRegime() {
      return this.event ? this.event.regime : this.regime;
    }

    // Signals use history through yesterday — no lookahead.
    _computeSignals() {
      for (const s of this.slots) {
        if (s.dead || !s.armed) { s.pos = 0; continue; }
        const hist = this.hist[s.instrument];
        if (!hist || hist.length < 3) { s.pos = 0; continue; }
        switch (s.strategy) {
          case 'MOMENTUM': s.pos = signalMomentum(hist, s.param); break;
          case 'MEAN_REV': s.pos = signalMeanRev(hist, s.param); break;
          case 'CARRY': s.pos = 1; break;
          case 'SENTIMENT': s.pos = signalSentiment(s); break;
          case 'BREAKOUT': s.pos = signalBreakout(hist, s.param); break;
          default: s.pos = 0;
        }
        s.pos = clamp(s.pos, -1, 1);
      }
    }

    _genMarketReturns() {
      const reg = REGIMES[this._effectiveRegime()];
      const returns = {};
      // One correlated market shock on event days.
      let mktShock = 0;
      if (this.eventTriggeredToday) {
        mktShock = reg.shock + this.rng.gauss() * 0.012;
      }
      for (const key of Object.keys(INSTRUMENTS)) {
        const cfg = INSTRUMENTS[key];
        const hist = this.hist[key];
        let mu = cfg.beta * reg.drift;
        // Mean-reversion anchor in RANGE regime.
        if (this._effectiveRegime() === 'RANGE' && hist.length > 20) {
          let anchor = 0, n = 0;
          for (let i = hist.length - 20; i < hist.length; i++) { anchor += hist[i].p; n++; }
          anchor /= n;
          mu += 0.10 * (anchor / this.prices[key] - 1);
        }
        const sd = Math.max(reg.vol * cfg.volScale, cfg.minVol);
        let r = mu + this.rng.gauss() * sd;
        if (this.rng.next() < reg.jumpProb) r += this.rng.gauss() * reg.jump * cfg.volScale * 1.5;
        if (this.eventTriggeredToday) {
          r += cfg.beta * mktShock * 0.7 + this.rng.gauss() * 0.005;
        }
        returns[key] = clamp(r, -0.3, 0.3);
      }
      return returns;
    }

    _applySlotReturns(returns) {
      const newLogs = [];
      for (const s of this.slots) {
        if (s.dead) continue;
        const r = returns[s.instrument];
        let stratRet;
        if (s.strategy === 'CARRY') {
          // vol-of-vol estimate over last 10 sessions for the vol bleed term
          const hst = this.hist[s.instrument];
          let n = 0, m = 0;
          const from = Math.max(1, hst.length - 10);
          for (let i = from; i < hst.length; i++) { m += hst[i].r; n++; }
          m /= Math.max(1, n);
          let vv = 0;
          for (let i = from; i < hst.length; i++) vv += (hst[i].r - m) * (hst[i].r - m);
          const vol10 = Math.sqrt(vv / Math.max(1, n));
          stratRet = carryReturn(r, vol10) * s.lev;
        } else {
          stratRet = s.pos * r * s.lev;
          if (s.strategy === 'SENTIMENT') stratRet -= 0.0001; // friction
        }
        stratRet = clamp(stratRet, -0.85, 0.85);
        // Turnover fee on position change (CARRY is premium-embedded, no churn).
        if (s.strategy !== 'CARRY' && s.posPrev != null && s.pos !== s.posPrev) {
          const turnover = Math.abs(s.pos - s.posPrev);
          s.equity -= turnover * s.equity * FEE_RATE;
        }
        s.equity *= (1 + stratRet);
        if (s.equity < 0) s.equity = 0;
        s.posPrev = s.pos;
        if (s.equity > s.peak) s.peak = s.equity;
      }
      return newLogs;
    }

    _updateSentimentMemory() {
      const imp = sentimentImpact(this._effectiveRegime());
      for (const s of this.slots) {
        if (s.strategy !== 'SENTIMENT' || s.dead) continue;
        const decay = Math.exp(-1 / Math.max(1, s.param));
        s.mem *= decay;
        if (this.eventTriggeredToday) {
          // Impact scales with the instrument's regime sensitivity — bonds rally
          // in risk-off, so sentiment flips sign correctly per instrument.
          s.mem += imp * INSTRUMENTS[s.instrument].beta * 1.0;
        }
      }
    }

    _rebalance() {
      this._normalizeAllocs();
      const book = this.bookEquity();
      const desired = this.slots.map((s) => {
        if (s.dead) return 0;
        if (!s.armed) return s.equity; // tripped: capital parked, exposure flat
        return s.alloc * book;
      });
      // Delta per slot; positive = inject capital, negative = withdraw.
      const deltas = this.slots.map((s, i) => desired[i] - s.equity);
      let fee = 0;
      for (const d of deltas) fee += Math.abs(d);
      fee *= FEE_RATE * 0.5; // each dollar moved charged once
      // Apply: withdrawals first (they fund deposits + cash).
      for (let i = 0; i < this.slots.length; i++) {
        if (deltas[i] < 0) {
          const w = -deltas[i];
          const take = Math.min(w, this.slots[i].equity);
          this.slots[i].equity -= take;
          this.cash += take;
          // Any unfulfillable remainder just stays (equity floor).
        }
      }
      let deposits = 0;
      for (const d of deltas) if (d > 0) deposits += d;
      // Available = cash after withdrawals. Scale deposits if short (rounding safety).
      let avail = this.cash;
      if (deposits > avail && deposits > 0) {
        const f = avail / deposits;
        for (let i = 0; i < this.slots.length; i++) {
          if (deltas[i] > 0) {
            const dep = deltas[i] * f;
            this.slots[i].equity += dep;
            avail -= dep;
          }
        }
        this.cash = Math.max(0, avail - fee);
      } else {
        for (let i = 0; i < this.slots.length; i++) {
          if (deltas[i] > 0) {
            this.slots[i].equity += deltas[i];
            avail -= deltas[i];
          }
        }
        this.cash = Math.max(0, avail - fee);
      }
      // Fee charged once against cash.
      // (cash already reduced by avail accounting; subtract fee explicitly)
      // Recompute: we subtracted deposits/withdrawals; fee comes out of cash.
      // Simplest correct: cash = bookEquity_after_trades - sum(slotEq). But we
      // already mutated. Do a final conservation fix:
      const eqNow = this.bookEquity();
      const targetCash = book - this.slots.reduce((a, s) => a + s.equity, 0);
      // targetCash already reflects post-trade book; apply fee as cash reduction.
      this.cash = Math.max(0, targetCash - fee);
      // Fix rounding drift so book equity is conserved minus fee.
      const drift = this.bookEquity() - (book - fee);
      if (Math.abs(drift) > 1e-6) this.cash = Math.max(0, this.cash - drift);
    }

    _checkBreakers() {
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i];
        if (s.dead || !s.armed) continue;
        if (s.peak > 0) {
          const dd = (s.peak - s.equity) / s.peak;
          if (dd > s.ddLimit) {
            s.armed = false;
            s.pos = 0;
            s.posPrev = 0;
            this._say('breaker', `BREAKER TRIPPED — Slot ${i + 1} (${s.strategy} ${s.instrument}) drawdown ${(dd * 100).toFixed(1)}% > ${(s.ddLimit * 100).toFixed(0)}% limit. Position force-flattened.`);
          }
        }
        if (s.equity < DEAD_FLOOR) {
          s.dead = true;
          s.armed = false;
          s.pos = 0;
          s.equity = 0;
          this._say('breaker', `SLOT ${i + 1} DECLARED DEAD — equity below floor. Capital recycled to cash. It will never trade again.`);
        }
      }
    }

    rearm(slotIndex) {
      const s = this.slots[slotIndex];
      if (!s || s.dead || s.armed) return false;
      s.armed = true;
      s.peak = s.equity;
      s.mem = 0;
      s.posPrev = null;
      this._say('system', `Slot ${slotIndex + 1} re-armed at equity $${s.equity.toLocaleString()}. Breaker reset — same mix, fresh watermark.`);
      return true;
    }

    step() {
      if (this.over) return [];
      const before = this.log.length;
      this.day++;
      this.eventTriggeredToday = false;

      // 1. Trigger scheduled events.
      while (this.eventQueue.length && this.eventQueue[0].day <= this.day) {
        const ev = this.eventQueue.shift();
        this.event = { regime: ev.regime, daysLeft: ev.dur, text: ev.text };
        // ~1 in 5 headlines is a rumor — it reverts fast. Don't chase every candle.
        if (this.rng.next() < 0.22) {
          this.event.daysLeft = Math.min(ev.dur, this.rng.int(1, 3));
          this.event.rumor = true;
        }
        this.eventTriggeredToday = true;
        this._say('event', `DAY ${this.day} — ${ev.text}`);
        this._say('regime', `Regime forced: ${REGIMES[ev.regime].label} for ~${ev.dur} days.`);
      }

      // 2. Regime machine (paused while event override active).
      if (this.event) {
        this.event.daysLeft--;
        if (this.event.daysLeft <= 0) {
          const wasRumor = this.event.rumor;
          this.event = null;
          this.regimeDays = this.rng.int(10, 30);
          this._say('regime', wasRumor
            ? `RUMOR FADES — unconfirmed reports collapse. Tape reverts to ${REGIMES[this.regime].label}.`
            : `Event regime expired. Tape returns to ${REGIMES[this.regime].label}.`);
        }
      } else {
        this.regimeDays--;
        if (this.regimeDays <= 0) {
          const weights = { ...REGIME_WEIGHTS };
          weights[this.regime] = 0;
          // Tape gets nastier as the mandate ages — the world wants you to fail.
          const ramp = 1 + (this.day / this.maxDay) * 1.5;
          weights.PANIC *= ramp;
          weights.RISK_OFF *= ramp;
          let tot = 0;
          for (const k of REGIME_KEYS) tot += weights[k];
          let x = this.rng.next() * tot, next = 'RANGE';
          for (const k of REGIME_KEYS) { x -= weights[k]; if (x <= 0) { next = k; break; } }
          if (next !== this.regime) {
            this.regime = next;
            this._say('regime', `Regime shift → ${REGIMES[next].label}`);
          }
          this.regimeDays = this.rng.int(REGIMES[next].dur[0], REGIMES[next].dur[1]);
        }
      }

      // 3. Signals (from history through yesterday).
      this._computeSignals();

      // 4. Market returns + price update.
      const returns = this._genMarketReturns();
      for (const key of Object.keys(INSTRUMENTS)) {
        const r = returns[key];
        this.prices[key] *= (1 + r);
        if (this.prices[key] <= 0) this.prices[key] = 1e-9;
        const h = this.hist[key];
        h.push({ p: this.prices[key], r });
        if (h.length > 250) h.shift();
      }

      // 5. Apply strategy returns + turnover fees.
      this._applySlotReturns(returns);

      // 6. Sentiment memory update (lags the news by a day — no front-running).
      this._updateSentimentMemory();

      // 7. Cash interest.
      this.cash *= (1 + CASH_RATE);

      // 8. Rebalance to target allocations.
      this._rebalance();

      // 9. Breakers + dead check.
      this._checkBreakers();

      // 10. Book equity, drawdown, ruin/win checks.
      const eq = this.bookEquity();
      const prev = this.equityHist[this.equityHist.length - 1].equity;
      const dayRet = prev > 0 ? eq / prev - 1 : 0;
      this.equityHist.push({ day: this.day, equity: eq, dd: this.peakEquity > 0 ? (this.peakEquity - eq) / this.peakEquity : 0, regime: this._effectiveRegime() });
      if (eq > this.peakEquity) this.peakEquity = eq;
      const dd = (this.peakEquity - eq) / this.peakEquity;
      if (dd > this.maxDD) this.maxDD = dd;

      if (eq < this.startEquity * RUIN_FRACTION) {
        this.over = true;
        this.result = this._result('LIQUIDATED');
        this._say('system', `DAY ${this.day} — ACCOUNT BLOWN. Equity $${eq.toLocaleString()} < ${(RUIN_FRACTION * 100).toFixed(0)}% ruin line. Regulators pull your mandate.`);
      } else if (this.day >= this.maxDay) {
        this.over = true;
        this.result = this._result('COMPLETE');
        this._say('system', `DAY ${this.day} — MANDATE COMPLETE. Final equity $${eq.toLocaleString()}.`);
      }
      return this.log.slice(before);
    }

    _result(status) {
      const eq = this.bookEquity();
      const rets = [];
      for (let i = 1; i < this.equityHist.length; i++) {
        const a = this.equityHist[i - 1].equity, b = this.equityHist[i].equity;
        if (a > 0) rets.push(b / a - 1);
      }
      let mean = 0, sd = 0;
      for (const r of rets) mean += r;
      mean /= Math.max(1, rets.length);
      for (const r of rets) sd += (r - mean) * (r - mean);
      sd = Math.sqrt(sd / Math.max(1, rets.length));
      const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
      const totalRet = eq / this.startEquity - 1;
      return {
        status, endEquity: eq, totalRet, sharpe,
        maxDD: this.maxDD, days: this.day,
        rank: this._rank(totalRet, status),
      };
    }

    _rank(totalRet, status) {
      if (status === 'LIQUIDATED') return 'LIQUIDATED';
      if (totalRet >= 1.0) return 'APEX — THE BOOK';
      if (totalRet >= 0.5) return 'LEGEND PM';
      if (totalRet >= 0.25) return 'STAR PM';
      if (totalRet >= 0.10) return 'PM';
      if (totalRet >= 0) return 'ANALYST';
      return 'ASSOCIATE — BARELY SURVIVED';
    }
  }

  const Sim = { Game, INSTRUMENTS, REGIMES, STRATEGIES, EVENT_TABLE, FEE_RATE, makeRng, mulberry32 };
  global.Sim = Sim;
  if (typeof module !== 'undefined' && module.exports) module.exports = Sim;
})(typeof window !== 'undefined' ? window : globalThis);
