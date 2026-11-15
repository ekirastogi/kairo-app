from __future__ import annotations

import threading
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from .config import env, env_int
from .db import alert_due, list_watch, mark_alert, update_registry_cmp
from .firebase_io import (
    finish_job,
    mark_tracker,
    pending_history_jobs,
    send_push,
    write_live_quotes,
)
from .groww import GrowwClient, GrowwError
from .history import fetch_symbol_history

IST = ZoneInfo("Asia/Kolkata")
HIT_PCT = 0.003  # 0.3% of the user level counts as a hit


class LiveTracker:
    def __init__(self) -> None:
        self.client = GrowwClient()
        self.user_id = env("KAIRO_USER_ID")
        self.poll = max(5, env_int("LIVE_POLL_SECONDS", 8))
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.status: dict[str, Any] = {"running": False, "error": "", "symbols": []}
        self._prev: dict[str, float] = {}

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="kairo-live", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        mark_tracker(False, "stopped")

    def _market_open(self) -> bool:
        now = datetime.now(IST)
        if now.weekday() >= 5:
            return False
        minutes = now.hour * 60 + now.minute
        return 9 * 60 + 10 <= minutes <= 15 * 60 + 40

    def _loop(self) -> None:
        self.status["running"] = True
        try:
            mark_tracker(True, "started")
        except Exception as exc:  # noqa: BLE001
            self.status["error"] = f"firestore: {exc}"
        if env("HISTORY_ON_START", "true").lower() == "true":
            try:
                self.backfill_all()
            except Exception as exc:  # noqa: BLE001
                self.status["error"] = str(exc)
        while not self._stop.is_set():
            try:
                self._tick()
                self._jobs()
                self.status["error"] = ""
            except Exception as exc:  # noqa: BLE001
                self.status["error"] = str(exc)
                mark_tracker(True, str(exc)[:240])
            self._stop.wait(self.poll)
        self.status["running"] = False

    def backfill_all(self) -> dict[str, dict[str, int]]:
        if not self.user_id:
            raise GrowwError("KAIRO_USER_ID is required")
        watches = list_watch(self.user_id)
        out = {}
        for row in watches:
            out[row["symbol"]] = fetch_symbol_history(self.client, row["symbol"])
        return out

    def backfill_one(self, symbol: str) -> dict[str, int]:
        return fetch_symbol_history(self.client, symbol.upper())

    def _jobs(self) -> None:
        for job in pending_history_jobs():
            symbol = str(job.get("symbol") or "").upper()
            if not symbol:
                finish_job(job["id"], "error", "missing symbol")
                continue
            try:
                self.backfill_one(symbol)
                finish_job(job["id"], "done")
            except Exception as exc:  # noqa: BLE001
                finish_job(job["id"], "error", str(exc)[:400])

    def _tick(self) -> None:
        if not self.user_id:
            raise GrowwError("KAIRO_USER_ID is required")
        watches = list_watch(self.user_id)
        symbols = [w["symbol"] for w in watches]
        self.status["symbols"] = symbols
        if not symbols:
            return
        if not self._market_open() and not env("LIVE_ALWAYS", ""):
            mark_tracker(True, "market closed — idle")
            return
        ltps = self.client.ltp_batch(symbols)
        quotes = {}
        for symbol, ltp in ltps.items():
            prev = self._prev.get(symbol, ltp)
            change = ltp - prev if prev else 0
            pct = (change / prev * 100) if prev else 0
            quotes[symbol] = {
                "ltp": ltp,
                "change": round(change, 2),
                "changePct": round(pct, 3),
                "name": next((w["name"] for w in watches if w["symbol"] == symbol), symbol),
            }
            self._prev[symbol] = ltp
        write_live_quotes(quotes)
        update_registry_cmp(self.user_id, ltps)
        levels = {w["symbol"]: w["prices"] for w in watches}
        self._alerts(ltps, levels)

    def _alerts(self, ltps: dict[str, float], levels: dict[str, list]) -> None:
        for symbol, ltp in ltps.items():
            prices = levels.get(symbol) or []
            for idx, raw in enumerate(prices):
                try:
                    price = float(raw)
                except (TypeError, ValueError):
                    continue
                if price <= 0:
                    continue
                dist = abs(ltp - price) / price
                if dist > HIT_PCT:
                    continue
                if not alert_due(symbol, price):
                    continue
                label = f"P{idx + 1}"
                title = f"{symbol} hit {label}"
                body = f"{symbol} is ₹{ltp:.2f}, {label} ₹{price:.2f} ({dist * 100:.2f}% away)."
                send_push(title, body, symbol)
                mark_alert(symbol, price, ltp)


tracker = LiveTracker()
