from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from .db import upsert_candles_cloud, upsert_candles_local
from .groww import GrowwClient

IST = ZoneInfo("Asia/Kolkata")

INTERVALS = [
    # interval, lookback_days, chunk_days (Groww max duration)
    ("5minute", 90, 30),
    ("30minute", 90, 90),
    ("1hour", 180, 180),
    ("1day", 180, 180),
    ("1week", 180, 180),
]


def _fmt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def _parse_ts(raw: Any) -> datetime | None:
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        sec = int(raw)
        if sec > 1_000_000_000_000:
            sec //= 1000
        return datetime.fromtimestamp(sec, tz=IST)
    text = str(raw).strip()
    for layout in (
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%d",
    ):
        try:
            dt = datetime.strptime(text.replace("Z", "+00:00"), layout)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=IST)
            return dt
        except ValueError:
            continue
    return None


def _rows_from_payload(symbol: str, interval: str, candles: list[list[Any]]) -> list[tuple]:
    rows = []
    for candle in candles:
        if not isinstance(candle, list) or len(candle) < 5:
            continue
        ts = _parse_ts(candle[0])
        if ts is None:
            continue
        try:
            o, h, l, c = float(candle[1]), float(candle[2]), float(candle[3]), float(candle[4])
            vol = float(candle[5]) if len(candle) > 5 and candle[5] is not None else 0.0
        except (TypeError, ValueError):
            continue
        rows.append((symbol, interval, ts, o, h, l, c, vol))
    return rows


def fetch_symbol_history(client: GrowwClient, symbol: str) -> dict[str, int]:
    symbol = symbol.upper()
    now = datetime.now(IST)
    counts: dict[str, int] = {}
    for interval, lookback, chunk in INTERVALS:
        start = now - timedelta(days=lookback)
        cursor = start
        total = 0
        while cursor < now:
            end = min(cursor + timedelta(days=chunk), now)
            payload = client.historical(symbol, interval, _fmt(cursor), _fmt(end))
            rows = _rows_from_payload(symbol, interval, payload)
            upsert_candles_local(rows)
            upsert_candles_cloud(rows)
            total += len(rows)
            cursor = end + timedelta(minutes=1)
            time.sleep(0.35)
        counts[interval] = total
    return counts
