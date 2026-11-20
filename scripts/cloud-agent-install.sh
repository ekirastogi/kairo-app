#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

write_backend_env() {
  if [ -z "${SUPABASE_DB_PASSWORD:-}" ]; then
    return 0
  fi

  local sa_path="${GOOGLE_APPLICATION_CREDENTIALS:-/tmp/firebase-sa.json}"
  if [ -n "${FIREBASE_SERVICE_ACCOUNT_JSON:-}" ]; then
    printf '%s' "$FIREBASE_SERVICE_ACCOUNT_JSON" > "$sa_path"
    chmod 600 "$sa_path"
    sa_path="/tmp/firebase-sa.json"
  fi

  cat > "$ROOT/backend/.env" <<EOF
SUPABASE_DB_HOST=db.vufjhwxlyhxunqhfeqtr.supabase.co
SUPABASE_DB_PORT=5432
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=postgres
SUPABASE_DB_PASSWORD=${SUPABASE_DB_PASSWORD}
FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID:-kairo-trade}
GOOGLE_APPLICATION_CREDENTIALS=${sa_path}
HTTP_ADDR=:8080
WORKER_FIRESTORE_MODE=ondemand
LOG_VERBOSE=false
MARKET_DATA_PROVIDER=groww
EOF
}

write_frontend_configs() {
  cd "$ROOT/frontend"

  if [ -n "${FIREBASE_WEB_CONFIG:-}" ]; then
    FIREBASE_WEB_CONFIG="$FIREBASE_WEB_CONFIG" node scripts/ensure-firebase-config.js --from-secrets
  elif [ ! -f src/environments/firebase.config.ts ]; then
    cp src/environments/firebase.config.example.ts src/environments/firebase.config.ts
  fi

  if [ -n "${SUPABASE_ANON_KEY:-}" ]; then
    export SUPABASE_URL="${SUPABASE_URL:-https://vufjhwxlyhxunqhfeqtr.supabase.co}"
    export SUPABASE_ANON_KEY
    node scripts/ensure-supabase-config.js --from-env
  elif [ ! -f src/environments/supabase.config.ts ]; then
    cp src/environments/supabase.config.example.ts src/environments/supabase.config.ts
  fi
}

echo "Installing frontend dependencies..."
cd "$ROOT/frontend"
npm ci --legacy-peer-deps

echo "Preparing frontend environment configs..."
write_frontend_configs

echo "Downloading Go modules..."
cd "$ROOT/backend"
go mod download

echo "Preparing backend environment..."
write_backend_env

echo "Cloud agent install complete."
