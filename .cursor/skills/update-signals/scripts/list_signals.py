#!/usr/bin/env python3
"""Dump signal_watch rows as JSON for the update-signals skill."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import psycopg2
from psycopg2.extras import RealDictCursor

ROOT = Path(__file__).resolve().parents[4]


def load_env() -> dict[str, str]:
    env: dict[str, str] = {}
    path = ROOT / "backend" / ".env"
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def connect():
    env = load_env()
    return psycopg2.connect(
        host=env.get("SUPABASE_DB_HOST") or "db.vufjhwxlyhxunqhfeqtr.supabase.co",
        port=int(env.get("SUPABASE_DB_PORT") or 5432),
        dbname=env.get("SUPABASE_DB_NAME") or "postgres",
        user=env.get("SUPABASE_DB_USER") or "postgres",
        password=env.get("SUPABASE_DB_PASSWORD") or "",
        sslmode="require",
        connect_timeout=20,
    )


def main() -> int:
    conn = connect()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                select w.id, w.user_id, w.symbol, w.name, w.prices, w.broker_targets,
                       w.overall_signal, w.signal_reason, w.nifty_note, w.sector_note,
                       r.current_price as cmp
                from public.signal_watch w
                left join public.registry_stocks r
                  on r.user_id = w.user_id and r.symbol = w.symbol
                order by w.symbol, w.created_at
                """
            )
            rows = list(cur.fetchall())
    finally:
        conn.close()
    print(json.dumps(rows, default=str, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"list_signals failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
