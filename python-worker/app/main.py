from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .config import env, env_int
from .groww import GrowwError
from .tracker import tracker

app = FastAPI(title="Kairo market worker", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    tracker.start()


@app.get("/health")
def health():
    return {
        "ok": True,
        "groww": tracker.client.configured(),
        "user": bool(env("KAIRO_USER_ID")),
        **tracker.status,
    }


@app.post("/history/{symbol}")
def history(symbol: str):
    try:
        counts = tracker.backfill_one(symbol)
    except GrowwError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, str(exc)) from exc
    return {"symbol": symbol.upper(), "candles": counts}


@app.post("/history")
def history_all():
    try:
        return tracker.backfill_all()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, str(exc)) from exc


def run() -> None:
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=env_int("PORT", 8765),
        reload=False,
    )


if __name__ == "__main__":
    run()
