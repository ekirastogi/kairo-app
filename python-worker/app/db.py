from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg

from .config import env, env_int


def local_connect():
    return psycopg.connect(
        host=env("LOCAL_PG_HOST", "127.0.0.1"),
        port=env_int("LOCAL_PG_PORT", 5433),
        dbname=env("LOCAL_PG_DB", "kairo_market"),
        user=env("LOCAL_PG_USER", "kairo"),
        password=env("LOCAL_PG_PASSWORD", "kairo"),
        connect_timeout=10,
        autocommit=True,
    )


def cloud_connect():
    return psycopg.connect(
        host=env("SUPABASE_DB_HOST") or "db.vufjhwxlyhxunqhfeqtr.supabase.co",
        port=env_int("SUPABASE_DB_PORT", 5432),
        dbname=env("SUPABASE_DB_NAME", "postgres"),
        user=env("SUPABASE_DB_USER", "postgres"),
        password=env("SUPABASE_DB_PASSWORD"),
        sslmode="require",
        connect_timeout=20,
        autocommit=True,
    )


@contextmanager
def local_cur() -> Iterator[Any]:
    with local_connect() as conn:
        with conn.cursor() as cur:
            yield cur


@contextmanager
def cloud_cur() -> Iterator[Any]:
    with cloud_connect() as conn:
        with conn.cursor() as cur:
            yield cur


def list_watch(user_id: str) -> list[dict[str, Any]]:
    with cloud_cur() as cur:
        cur.execute(
            """
            select symbol, name, prices, user_id
            from public.signal_watch
            where user_id = %s
            order by symbol
            """,
            (user_id,),
        )
        rows = cur.fetchall()
    return [
        {
            "symbol": str(r[0]).upper(),
            "name": r[1] or r[0],
            "prices": r[2] if isinstance(r[2], list) else [],
            "user_id": r[3],
        }
        for r in rows
    ]


_CANDLE_SQL = """
insert into {table} (symbol, interval, ts, open, high, low, close, volume)
values (%s, %s, %s, %s, %s, %s, %s, %s)
on conflict (symbol, interval, ts) do update
set open = excluded.open, high = excluded.high, low = excluded.low,
    close = excluded.close, volume = excluded.volume
"""


def upsert_candles_local(rows: list[tuple]) -> None:
    if not rows:
        return
    with local_cur() as cur:
        cur.executemany(_CANDLE_SQL.format(table="candles"), rows)


def upsert_candles_cloud(rows: list[tuple]) -> None:
    if not rows:
        return
    with cloud_cur() as cur:
        cur.executemany(_CANDLE_SQL.format(table="public.ohlc_candles"), rows)


def update_registry_cmp(user_id: str, quotes: dict[str, float]) -> None:
    if not quotes:
        return
    now_ms = int(time.time() * 1000)
    with cloud_cur() as cur:
        for symbol, ltp in quotes.items():
            cur.execute(
                """
                update public.registry_stocks
                set current_price = %s, updated_at = %s
                where user_id = %s and symbol = %s
                """,
                (ltp, now_ms, user_id, symbol),
            )


def alert_due(symbol: str, price: float, cooldown_min: int = 30) -> bool:
    with local_cur() as cur:
        cur.execute(
            "select last_fired_at from level_alerts where symbol = %s and price = %s",
            (symbol, price),
        )
        row = cur.fetchone()
        if not row:
            return True
        cur.execute("select extract(epoch from (now() - %s))/60", (row[0],))
        minutes = float((cur.fetchone() or [0])[0] or 0)
        return minutes >= cooldown_min


def mark_alert(symbol: str, price: float, ltp: float) -> None:
    with local_cur() as cur:
        cur.execute(
            """
            insert into level_alerts (symbol, price, last_fired_at, last_ltp)
            values (%s, %s, now(), %s)
            on conflict (symbol, price) do update
            set last_fired_at = now(), last_ltp = excluded.last_ltp
            """,
            (symbol, price, ltp),
        )
