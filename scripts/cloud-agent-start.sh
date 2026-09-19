#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Reconcile backend .env when secrets are injected after install (e.g. first boot from build).
if [ -n "${SUPABASE_DB_PASSWORD:-}" ] && [ ! -f "$ROOT/backend/.env" ]; then
  "$ROOT/scripts/cloud-agent-install.sh"
fi

exit 0
