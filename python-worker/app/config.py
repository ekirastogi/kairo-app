from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
WORKER = Path(__file__).resolve().parents[1]


def _load() -> None:
    load_dotenv(ROOT / "backend" / ".env", override=False)
    load_dotenv(WORKER / ".env", override=True)


_load()


def env(key: str, default: str = "") -> str:
    return (os.getenv(key) or default).strip()


def env_int(key: str, default: int) -> int:
    raw = env(key)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default
