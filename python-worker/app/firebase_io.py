from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

from .config import ROOT, env

_app = None


def firebase_app():
    global _app
    if _app is not None:
        return _app
    import firebase_admin
    from firebase_admin import credentials

    cred_path = env("GOOGLE_APPLICATION_CREDENTIALS")
    if cred_path and not os.path.isabs(cred_path):
        cred_path = str(ROOT / cred_path)
    if cred_path and os.path.exists(cred_path):
        _app = firebase_admin.initialize_app(credentials.Certificate(cred_path))
    else:
        _app = firebase_admin.initialize_app()
    return _app


def firestore():
    from firebase_admin import firestore as fs

    firebase_app()
    return fs.client()


def write_live_quotes(quotes: dict[str, dict[str, Any]]) -> None:
    db = firestore()
    batch = db.batch()
    now = datetime.now(timezone.utc)
    for i, (symbol, payload) in enumerate(quotes.items()):
        ref = db.collection("liveQuotes").document(symbol)
        batch.set(ref, {**payload, "updatedAt": now, "symbol": symbol}, merge=True)
        if i and i % 400 == 0:
            batch.commit()
            batch = db.batch()
    batch.commit()
    db.collection("worker").document("liveTracker").set(
        {
            "running": True,
            "lastTick": now,
            "symbols": sorted(quotes.keys()),
            "count": len(quotes),
        },
        merge=True,
    )


def mark_tracker(running: bool, note: str = "") -> None:
    firestore().collection("worker").document("liveTracker").set(
        {
            "running": running,
            "note": note,
            "updatedAt": datetime.now(timezone.utc),
        },
        merge=True,
    )


def pending_history_jobs() -> list[dict[str, Any]]:
    db = firestore()
    docs = db.collection("workerJobs").where("status", "==", "pending").limit(40).stream()
    out = []
    for doc in docs:
        data = doc.to_dict() or {}
        if data.get("type") not in ("fetch_history", "symbol_ingest"):
            continue
        data["id"] = doc.id
        out.append(data)
    return out


def finish_job(job_id: str, status: str, error: str = "") -> None:
    mapped = "completed" if status in ("done", "completed") else "failed"
    firestore().collection("workerJobs").document(job_id).set(
        {"status": mapped, "error": error, "completedAt": datetime.now(timezone.utc)},
        merge=True,
    )


def fcm_tokens() -> list[str]:
    db = firestore()
    tokens = []
    for doc in db.collection("fcmTokens").stream():
        data = doc.to_dict() or {}
        token = str(data.get("token") or doc.id).strip()
        if token:
            tokens.append(token)
    return tokens


def send_push(title: str, body: str, symbol: str) -> None:
    from firebase_admin import messaging

    firebase_app()
    tokens = fcm_tokens()
    if not tokens:
        return
    for token in tokens:
        try:
            messaging.send(
                messaging.Message(
                    notification=messaging.Notification(title=title, body=body),
                    token=token,
                    data={"symbol": symbol, "click_action": "FLUTTER_NOTIFICATION_CLICK"},
                    webpush=messaging.WebpushConfig(
                        fcm_options=messaging.WebpushFCMOptions(
                            link=f"/stock/{symbol}"
                        )
                    ),
                )
            )
        except Exception:
            continue
