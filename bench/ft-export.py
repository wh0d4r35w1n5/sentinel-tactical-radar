#!/usr/bin/env python3
# ft-export.py — read the freqtrade dry-run sqlite and publish the benchmark
# stats to /opt/sentinel/api/freqtrade-bench.json. Runs under cron/loop;
# read-only on the DB, writes via tmp+rename like the rest of the pipeline.
import json, os, sqlite3, sys, tempfile, time

DB = os.path.expanduser("~/ft-bench/tradesv3.dryrun.sqlite")
OUT = "/opt/sentinel/api/freqtrade-bench.json"

def main():
    if not os.path.exists(DB):
        return
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT pair, is_open, open_date, close_date, open_rate, close_rate,"
        " close_profit, close_profit_abs, exit_reason, leverage, amount, stake_amount"
        " FROM trades ORDER BY id"
    ).fetchall()
    closed = [r for r in rows if not r["is_open"]]
    open_ = [r for r in rows if r["is_open"]]
    wins = [r for r in closed if (r["close_profit_abs"] or 0) > 0]
    gross_w = sum(r["close_profit_abs"] or 0 for r in wins)
    gross_l = abs(sum(r["close_profit_abs"] or 0 for r in closed if (r["close_profit_abs"] or 0) <= 0))
    by_pair = {}
    for r in closed:
        d = by_pair.setdefault(r["pair"], {"n": 0, "net": 0.0, "wins": 0})
        d["n"] += 1
        d["net"] += r["close_profit_abs"] or 0
        d["wins"] += 1 if (r["close_profit_abs"] or 0) > 0 else 0
    out = {
        "refreshedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "note": "freqtrade dry-run benchmark — hypothetical fills on public candles, no orders ever sent",
        "strategy": "SentinelBenchStrategy",
        "trades": len(rows),
        "open": len(open_),
        "closed": len(closed),
        "wins": len(wins),
        "winRatePct": round(len(wins) / len(closed) * 100, 1) if closed else None,
        "netUsd": round(sum(r["close_profit_abs"] or 0 for r in closed), 4),
        "profitFactor": round(gross_w / gross_l, 2) if gross_l > 0 else None,
        "byPair": {k: {"n": v["n"], "netUsd": round(v["net"], 2),
                       "winRatePct": round(v["wins"] / v["n"] * 100, 1)} for k, v in by_pair.items()},
        "lastTrades": [
            {"pair": r["pair"], "open": r["open_date"], "close": r["close_date"],
             "entry": r["open_rate"], "exit": r["close_rate"],
             "pnlPct": round((r["close_profit"] or 0) * 100, 2),
             "pnlUsd": round(r["close_profit_abs"] or 0, 2), "why": r["exit_reason"]}
            for r in closed[-10:]
        ],
    }
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(OUT), suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(out, f)
    os.rename(tmp, OUT)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ft-export: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(0)  # benchmark exporter must never crash the loop host
