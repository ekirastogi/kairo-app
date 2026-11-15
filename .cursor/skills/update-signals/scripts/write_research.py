#!/usr/bin/env python3
"""Apply research JSON onto public.signal_watch (by symbol)."""
from __future__ import annotations

import json
import sys
import time
import uuid
from pathlib import Path

import psycopg2
from psycopg2.extras import Json, RealDictCursor

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


def clip_news(raw) -> list:
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        out.append(
            {
                "title": title,
                "source": str(item.get("source") or "").strip(),
                "url": str(item.get("url") or "").strip(),
                "publishedAt": str(item.get("publishedAt") or item.get("published_at") or "").strip(),
                "summary": str(item.get("summary") or "").strip(),
            }
        )
        if len(out) >= 10:
            break
    return out


def optional_float(value) -> float | None:
    try:
        price = float(value)
    except (TypeError, ValueError):
        return None
    if not (price > 0):
        return None
    return round(price, 2)


def clip_brokers(raw) -> list:
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        broker = str(item.get("broker") or item.get("name") or "").strip()
        try:
            price = float(item.get("price"))
        except (TypeError, ValueError):
            continue
        if not broker or price <= 0:
            continue
        out.append({"broker": broker, "price": round(price, 2)})
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: write_research.py research.json", file=sys.stderr)
        return 2
    payload = json.loads(Path(sys.argv[1]).read_text())
    stocks = payload.get("stocks") or []
    default_nifty = str(payload.get("niftyNote") or "").strip()
    now = int(time.time() * 1000)
    conn = connect()
    conn.autocommit = True
    updated = 0
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            for stock in stocks:
                symbol = str(stock.get("symbol") or "").strip().upper()
                if not symbol:
                    continue
                signal = str(stock.get("overallSignal") or "neutral").strip().lower()
                if signal not in ("positive", "negative", "neutral"):
                    signal = "neutral"
                news = clip_news(stock.get("news"))
                brokers = clip_brokers(stock.get("brokerTargets"))
                nifty = str(stock.get("niftyNote") or default_nifty).strip()
                sector = str(stock.get("sectorNote") or "").strip()
                reason = str(stock.get("signalReason") or "").strip()
                title = str(stock.get("analysisTitle") or "").strip() or f"{signal.capitalize()} · daily note"
                body = str(stock.get("analysis") or stock.get("analysisBody") or "").strip()
                report = None
                if body:
                    report = {
                        "id": str(uuid.uuid4()),
                        "createdAt": now,
                        "overallSignal": signal,
                        "title": title,
                        "body": body,
                    }
                cmp = optional_float(stock.get("cmp") or stock.get("currentPrice"))
                pe = optional_float(stock.get("pe"))
                market_cap = optional_float(stock.get("marketCap") or stock.get("market_cap"))
                sales_ttm = optional_float(stock.get("salesGrowthTtm") or stock.get("sales_growth_ttm"))
                profit_ttm = optional_float(stock.get("profitGrowthTtm") or stock.get("profit_growth_ttm"))
                cur.execute(
                    """
                    select id, user_id, name, broker_targets, ai_analyses
                    from public.signal_watch
                    where symbol = %s
                    """,
                    (symbol,),
                )
                rows = list(cur.fetchall())
                for row in rows:
                    existing_brokers = row["broker_targets"] if isinstance(row["broker_targets"], list) else []
                    next_brokers = brokers if brokers else existing_brokers
                    existing_ai = row["ai_analyses"] if isinstance(row["ai_analyses"], list) else []
                    if report:
                        if existing_ai and str(existing_ai[0].get("title") or "") == title:
                            next_ai = ([report] + existing_ai[1:])[:10]
                        else:
                            next_ai = ([report] + existing_ai)[:10]
                    else:
                        next_ai = existing_ai[:10]
                    cur.execute(
                        """
                        update public.signal_watch
                        set news = %s,
                            overall_signal = %s,
                            signal_reason = %s,
                            nifty_note = %s,
                            sector_note = %s,
                            news_updated_at = %s,
                            broker_targets = %s,
                            ai_analyses = %s,
                            updated_at = %s
                        where id = %s
                        """,
                        (
                            Json(news),
                            signal,
                            reason,
                            nifty,
                            sector,
                            now,
                            Json(next_brokers),
                            Json(next_ai),
                            now,
                            row["id"],
                        ),
                    )
                    updated += cur.rowcount
                    if cmp is None:
                        continue
                    name = str(row["name"] or symbol)
                    cur.execute(
                        """
                        insert into public.registry_stocks (
                          user_id, symbol, name, current_price, source, updated_at,
                          pe, market_cap, sales_growth_ttm, profit_growth_ttm
                        )
                        values (%s, %s, %s, %s, 'manual', %s, %s, %s, %s, %s)
                        on conflict (user_id, symbol) do update
                        set current_price = excluded.current_price,
                            updated_at = excluded.updated_at,
                            pe = coalesce(excluded.pe, public.registry_stocks.pe),
                            market_cap = coalesce(excluded.market_cap, public.registry_stocks.market_cap),
                            sales_growth_ttm = coalesce(excluded.sales_growth_ttm, public.registry_stocks.sales_growth_ttm),
                            profit_growth_ttm = coalesce(excluded.profit_growth_ttm, public.registry_stocks.profit_growth_ttm),
                            name = case
                              when coalesce(public.registry_stocks.name, '') = '' then excluded.name
                              else public.registry_stocks.name
                            end
                        """,
                        (
                            row["user_id"],
                            symbol,
                            name,
                            cmp,
                            now,
                            pe,
                            market_cap,
                            sales_ttm,
                            profit_ttm,
                        ),
                    )
    finally:
        conn.close()
    print(json.dumps({"updatedRows": updated, "stocks": len(stocks)}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"write_research failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
