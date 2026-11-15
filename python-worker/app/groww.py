from __future__ import annotations

import hashlib
import time
from typing import Any

import httpx

from .config import env

GROWW_API = "https://api.groww.in"


class GrowwError(RuntimeError):
    pass


class GrowwClient:
    def __init__(self) -> None:
        self._http = httpx.Client(timeout=45.0)
        self._token = env("GROWW_ACCESS_TOKEN")
        self._api_key = env("GROWW_API_KEY")
        self._api_secret = env("GROWW_API_SECRET")
        self._totp = env("GROWW_TOTP")

    def configured(self) -> bool:
        return bool(self._token or self._api_key)

    def ensure_token(self) -> str:
        if self._token:
            return self._token
        if not self._api_key:
            raise GrowwError("set GROWW_ACCESS_TOKEN or GROWW_API_KEY")
        timestamp = str(int(time.time()))
        if self._totp:
            body = {"key_type": "totp", "totp": self._totp}
        elif self._api_secret:
            digest = hashlib.sha256((self._api_secret + timestamp).encode()).hexdigest()
            body = {"key_type": "approval", "checksum": digest, "timestamp": timestamp}
        else:
            raise GrowwError("set GROWW_API_SECRET or GROWW_TOTP")
        resp = self._http.post(
            f"{GROWW_API}/v1/token/api/access",
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json=body,
        )
        if resp.status_code >= 400:
            raise GrowwError(f"auth http {resp.status_code}: {resp.text[:400]}")
        data = resp.json()
        token = data.get("token") or (data.get("payload") or {}).get("token")
        if not token:
            raise GrowwError(f"no token in auth response: {data}")
        self._token = str(token)
        return self._token

    def _get(self, path: str, params: dict[str, Any]) -> Any:
        token = self.ensure_token()
        resp = self._http.get(
            f"{GROWW_API}{path}",
            params=params,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "X-API-VERSION": "1.0",
            },
        )
        if resp.status_code >= 400:
            raise GrowwError(f"GET {path} http {resp.status_code}: {resp.text[:500]}")
        body = resp.json()
        if isinstance(body, dict) and str(body.get("status") or "").upper() == "FAILURE":
            raise GrowwError(str(body.get("error") or body))
        if isinstance(body, dict) and "payload" in body:
            return body["payload"]
        return body

    def ltp_batch(self, symbols: list[str]) -> dict[str, float]:
        out: dict[str, float] = {}
        chunk = 40
        for i in range(0, len(symbols), chunk):
            keys = [f"NSE_{s}" for s in symbols[i : i + chunk]]
            payload = self._get(
                "/v1/live-data/ltp",
                {"segment": "CASH", "exchange_symbols": ",".join(keys)},
            )
            if not isinstance(payload, dict):
                continue
            for key, value in payload.items():
                try:
                    ltp = float(value)
                except (TypeError, ValueError):
                    continue
                if ltp <= 0:
                    continue
                symbol = key.split("_", 1)[-1].upper()
                out[symbol] = ltp
        return out

    def historical(self, symbol: str, interval: str, start: str, end: str) -> list[list[Any]]:
        payload = self._get(
            "/v1/historical/candles",
            {
                "exchange": "NSE",
                "segment": "CASH",
                "groww_symbol": f"NSE-{symbol}",
                "start_time": start,
                "end_time": end,
                "candle_interval": interval,
            },
        )
        if not isinstance(payload, dict):
            return []
        candles = payload.get("candles") or []
        return candles if isinstance(candles, list) else []
