#!/usr/bin/env python3
"""
OKX BTC Options - Live WebSocket Feed
Subscribes to the opt-summary channel and displays all BTC option contracts
with live Greeks and implied volatility data.

Dependencies: pip install websockets tabulate
"""

import asyncio
import json
import os
from datetime import datetime
from collections import defaultdict
from tabulate import tabulate
import websockets

WS_URL = "wss://ws.okx.com:8443/ws/v5/public"
INST_FAMILY = "BTC-USD"
HEARTBEAT_INTERVAL = 25  # seconds — OKX drops connection after ~30s of silence

# Store latest data keyed by instId
options_data = {}


def parse_inst_id(inst_id: str) -> dict:
    """
    Parse OKX option symbol into its components.
    Format: BTC-USD-250328-70000-C
    """
    parts = inst_id.split("-")
    if len(parts) < 5:
        return {}
    try:
        expiry_raw = parts[2]  # YYMMDD
        year = int("20" + expiry_raw[:2])
        month = int(expiry_raw[2:4])
        day = int(expiry_raw[4:6])
        expiry = f"{year}-{month:02d}-{day:02d}"
        strike = float(parts[3])
        option_type = "CALL" if parts[4] == "C" else "PUT"
        return {"expiry": expiry, "strike": strike, "type": option_type}
    except (ValueError, IndexError):
        return {}


def render_table():
    """Clear screen and print a formatted table of all live options, grouped by expiry."""
    os.system("clear")
    print(f"OKX BTC Options — Live Feed  |  {datetime.now().strftime('%H:%M:%S')}")
    print(f"Contracts tracked: {len(options_data)}\n")

    # Group by expiry
    by_expiry = defaultdict(list)
    for inst_id, d in options_data.items():
        parsed = parse_inst_id(inst_id)
        if not parsed:
            continue
        by_expiry[parsed["expiry"]].append({
            "instId": inst_id,
            "type": parsed["type"],
            "strike": parsed["strike"],
            "delta": d.get("delta", ""),
            "gamma": d.get("gamma", ""),
            "theta": d.get("theta", ""),
            "vega": d.get("vega", ""),
            "markVol": d.get("markVol", ""),
            "bidVol": d.get("bidVol", ""),
            "askVol": d.get("askVol", ""),
        })

    for expiry in sorted(by_expiry.keys()):
        contracts = sorted(by_expiry[expiry], key=lambda x: (x["strike"], x["type"]))
        rows = []
        for c in contracts:
            def fmt(v, decimals=4):
                try:
                    return f"{float(v):.{decimals}f}"
                except (ValueError, TypeError):
                    return "-"

            rows.append([
                c["type"],
                f"${c['strike']:,.0f}",
                fmt(c["delta"]),
                fmt(c["gamma"], 6),
                fmt(c["theta"]),
                fmt(c["vega"]),
                fmt(c["markVol"]),
                fmt(c["bidVol"]),
                fmt(c["askVol"]),
            ])

        headers = ["Type", "Strike", "Delta", "Gamma", "Theta", "Vega", "Mark IV", "Bid IV", "Ask IV"]
        print(f"Expiry: {expiry}  ({len(contracts)} contracts)")
        print(tabulate(rows, headers=headers, tablefmt="simple"))
        print()


async def heartbeat(ws):
    """Send ping every HEARTBEAT_INTERVAL seconds to keep the connection alive."""
    while True:
        await asyncio.sleep(HEARTBEAT_INTERVAL)
        await ws.send("ping")


async def subscribe():
    print(f"Connecting to OKX WebSocket...")
    print(f"Subscribing to opt-summary for {INST_FAMILY}...\n")

    async with websockets.connect(WS_URL, ping_interval=None) as ws:
        # Send subscription message
        sub_msg = {
            "op": "subscribe",
            "args": [
                {
                    "channel": "opt-summary",
                    "instFamily": INST_FAMILY,
                }
            ],
        }
        await ws.send(json.dumps(sub_msg))

        # Start heartbeat task
        asyncio.create_task(heartbeat(ws))

        async for raw in ws:
            # OKX heartbeat response
            if raw == "pong":
                continue

            msg = json.loads(raw)

            # Subscription confirmation
            if msg.get("event") == "subscribe":
                print(f"Subscribed to: {msg.get('arg', {}).get('channel')} — waiting for data...")
                continue

            # Error from OKX
            if msg.get("event") == "error":
                print(f"OKX error: {msg.get('msg')} (code {msg.get('code')})")
                continue

            # Data push
            if "data" in msg:
                for item in msg["data"]:
                    inst_id = item.get("instId")
                    if inst_id:
                        options_data[inst_id] = item

                render_table()


def main():
    try:
        asyncio.run(subscribe())
    except KeyboardInterrupt:
        print("\nDisconnected.")


if __name__ == "__main__":
    main()
