"""Sentinel VIP signal feed — posts real fills to the VIP channel.

Polls state/real-fills.json for new open/close fills and posts formatted
signals. Own session copy + own systemd unit — never touches tg-watch.

Dedup state: /opt/sentinel/state/vip-signals.json
"""
import json, asyncio, time, os
from telethon import TelegramClient, types
from telethon.errors import FloodWaitError

BASE = "/opt/sentinel"
CFG = BASE + "/scripts/tg-config.json"
SESS = BASE + "/state/tg-signal-sess"          # dedicated session copy
STATE = BASE + "/state/vip-signals.json"
VIP = BASE + "/state/vip-state.json"           # channel id + username
POLL = 15
MAX_AGE_MS = 20 * 60 * 1000      # fills older than this at processing time are skipped — no backfill floods
MAX_BATCH = 12                   # per-cycle post cap; the cursor advances regardless

def fmtp(x):
    x = float(x)
    if x >= 1000: return f"{x:,.1f}"
    if x >= 10: return f"{x:,.2f}"
    return f"{x:,.4f}"

def load_json(p, d=None):
    try:
        return json.load(open(p))
    except Exception:
        return d

def find_plan(symbol, direction, plans):
    best = None
    for o in plans or []:
        if o.get("symbol") == symbol and (o.get("direction") or "").upper() == direction.upper():
            if best is None or (o.get("score") or 0) > (best.get("score") or 0):
                best = o
    return best

def sig_text(f, plan):
    side = "LONG" if f.get("side") == "buy" else "SHORT"
    em = "🟢" if side == "LONG" else "🔴"
    src = "OPERATOR" if f.get("src") == "web" else "SIGNAL"
    lines = [
        f"{em} <b>{side} {f['symbol']}</b>  ·  {src}",
        f"Entry <b>{fmtp(f['price'])}</b>",
    ]
    if plan:
        if plan.get("stopPct"):
            sl = f["price"] * (1 - plan["stopPct"] / 100) if side == "LONG" else f["price"] * (1 + plan["stopPct"] / 100)
            tp = f["price"] * (1 + plan["targetPct"] / 100) if side == "LONG" else f["price"] * (1 - plan["targetPct"] / 100)
            lines.append(f"SL <code>{fmtp(sl)}</code>  ·  TP <code>{fmtp(tp)}</code>")
        meta = " · ".join(x for x in [
            plan.get("strategy"), f"grade {plan.get('grade')}" if plan.get("grade") else None,
            f"score {plan.get('score')}" if plan.get("score") else None,
            f"{plan.get('leverage')}x" if plan.get("leverage") else None] if x)
        if meta:
            lines.append(f"<i>{meta}</i>")
    lines.append(f"<i>{time.strftime('%H:%M UTC', time.gmtime(f['ts'] / 1000))} · evidence gallery: 54-66-217-111.sslip.io/gallery.html</i>")
    return "\n".join(lines)

def close_text(f, pos_entry):
    side = "LONG" if f.get("side") == "sell" else "SHORT"
    pnl = (f.get("profit") or 0) - (f.get("fee") or 0)
    em = "✅" if pnl > 0 else "🔻"
    ret = ""
    if pos_entry:
        pct = (f["price"] - pos_entry) / pos_entry * 100 * (1 if side == "LONG" else -1)
        ret = f" ({pct:+.2f}%)"
    return (f"{em} <b>{side} {f['symbol']} — CLOSED</b>\n"
            f"Exit <b>{fmtp(f['price'])}</b> · net <b>${pnl:+.2f}</b>{ret}")

def fid(f):
    return f"{f.get('symbol')}:{f.get('side')}:{f.get('tradeSide')}:{f.get('ts')}:{f.get('size')}"

async def send(ch, text, tries=3):
    for i in range(tries):
        try:
            await c_send(ch, text)
            return True
        except FloodWaitError as e:
            await asyncio.sleep(min(e.seconds + 1, 120))
        except Exception as e:
            print("[vip-signals] send err:", str(e)[:80], flush=True)
            await asyncio.sleep(2 + i * 4)
    return False

c_send = None  # bound in main once the client exists

async def main():
    cfg = load_json(CFG)
    vip = load_json(VIP, {})
    ch_id = vip.get("channel_id")
    assert ch_id, "vip-state.json missing channel_id"
    st = load_json(STATE, {"seen": 0, "entries": {}, "ids": []})
    st.setdefault("entries", {})   # older state files lack the key — []["entries"] throws
    st.setdefault("ids", [])
    # first run: don't backfill the whole journal into the channel — start now
    if not st.get("seen"):
        st["seen"] = int(time.time() * 1000)
        json.dump(st, open(STATE, "w"))
    seen_ts = st.get("seen", 0)
    seen_ids = set(st.get("ids") or [])
    ids_list = list(st.get("ids") or [])  # ordered — set() can't slice newest
    now_ms = lambda: int(time.time() * 1000)

    c = TelegramClient(SESS, cfg["api_id"], cfg["api_hash"])
    await c.connect()
    assert await c.is_user_authorized()
    global c_send
    c_send = lambda ch, text: c.send_message(ch, text, parse_mode="html", link_preview=False)
    ch = await c.get_entity(types.PeerChannel(ch_id))
    print("[vip-signals] posting to", vip.get("username") or ch_id, flush=True)

    backoff = POLL
    while True:
        try:
            fills = (load_json(BASE + "/state/real-fills.json", {}) or {}).get("fills", [])
            plans = (load_json(BASE + "/api/live-plan.json", {}) or {}).get("orders", [])
            t_now = now_ms()
            new = [f for f in fills
                   if (f.get("ts") or 0) > seen_ts
                   and f.get("tradeSide") in ("open", "close")
                   and fid(f) not in seen_ids]
            for f in sorted(new, key=lambda x: x.get("ts", 0))[:MAX_BATCH]:
                seen_ts = f.get("ts", seen_ts)
                seen_ids.add(fid(f))
                ids_list.append(fid(f))
                if t_now - (f.get("ts") or 0) > MAX_AGE_MS:
                    print(f"[vip-signals] skip stale {f.get('symbol')} fill ({int((t_now - f.get('ts', 0)) / 60000)}m old)", flush=True)
                    continue
                try:
                    if f["tradeSide"] == "open":
                        side = "LONG" if f.get("side") == "buy" else "SHORT"
                        plan = find_plan(f["symbol"], side, plans)
                        if await send(ch, sig_text(f, plan)):
                            st["entries"][f["symbol"] + ":" + side] = f["price"]
                    else:
                        side = "LONG" if f.get("side") == "sell" else "SHORT"
                        ent = st["entries"].pop(f["symbol"] + ":" + side, None)
                        await send(ch, close_text(f, ent))
                except Exception as e:
                    print("[vip-signals] post err:", str(e)[:80], flush=True)
                await asyncio.sleep(1.5)
            if new:
                st["seen"] = seen_ts
                st["ids"] = ids_list[-300:]
                st["entries"] = dict(list(st["entries"].items())[-50:])
                json.dump(st, open(STATE, "w"))

            # daily desk brief — the fund ritual, automated: equity, open
            # book, 24h realized, breaker state. Once per UTC day ~00:10.
            today = time.strftime("%Y-%m-%d")
            if time.strftime("%H:%M") >= "00:10" and st.get("brief") != today:
                st["brief"] = today
                json.dump(st, open(STATE, "w"))
                try:
                    ll = load_json(BASE + "/api/live-ledger.json", {}) or {}
                    cb = ll.get("circuitBreakers") or {}
                    mk = load_json(BASE + "/api/markouts.json", {}) or {}
                    d60s = [r["d60"] for r in mk.get("rows", []) if r.get("d60") is not None]
                    med = sorted(d60s)[len(d60s) // 2] if d60s else None
                    pos = ll.get("positions") or []
                    posl = "  \n".join(
                        f"  • {p['symbol']} {p['side'].upper()} {p.get('lev','?')}x · upl ${(p.get('upl') or 0):+.2f} · liq {fmtp(p.get('liq') or 0)}"
                        for p in pos) or "  flat"
                    msg = (
                        f"🌅 <b>DESK BRIEF — {today}</b>\n\n"
                        f"Equity <b>${ll.get('equityUsd','?')}</b> · 24h realized <b>${(cb.get('net24Usd') or 0):+.2f}</b> · fees ${(cb.get('fees24Usd') or 0):.2f}\n"
                        f"WR(last20) {cb.get('winRate20','?')}% · breaker: <i>{'🔴 ' + str(cb.get('tripped'))[:80] if cb.get('tripped') else '🟢 clear'}</i>\n"
                        f"Open book:\n{posl}\n"
                        + (f"Exit quality: med 60s post-exit drift {med:+.2f}% over {len(d60s)} fills\n" if med is not None else "")
                        + "\n<i>Every fill auditable: 54-66-217-111.sslip.io/gallery.html</i>"
                    )
                    await send(ch, msg)
                except Exception as e:
                    print("[vip-signals] brief err:", str(e)[:80], flush=True)
            backoff = POLL
        except Exception as e:
            print("[vip-signals] loop err:", str(e)[:100], flush=True)
            backoff = min(backoff * 2, 300)
        await asyncio.sleep(backoff)

if __name__ == "__main__":
    asyncio.run(main())
