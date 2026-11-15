# Kairo market worker (Python)

Start this on your laptop each morning. It talks to Groww, stores candles in **local Docker Postgres**, mirrors them to **cloud Supabase** (so the hosted UI / phone can chart), and writes live LTPs to **Firestore**.

The Firebase-hosted app never calls `localhost`. HTTPS pages cannot reach a local HTTP server from your phone.

## One-time

```bash
cd python-worker
cp .env.example .env   # then fill GROWW_* and KAIRO_USER_ID (Firebase uid)
docker compose up -d
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Apply cloud candles table once (from repo root, as postgres):

```bash
psql "$SUPABASE_DB_URL" -f supabase/migrations/031_ohlc_candles.sql
```

Or use the same SQL apply path as other Kairo migrations.

## Each market morning

```bash
cd python-worker
source .venv/bin/activate
python -m app.main
```

Leave it running. It backfills history on start, then polls TradeBook symbols.

Optional laptop-only checks: `http://127.0.0.1:8765/health`
