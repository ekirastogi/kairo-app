#!/usr/bin/env bash
# Commit, push, and deploy the frontend in one step.
# Usage:
#   ./scripts/ship.sh "commit message"
#   ./scripts/ship.sh --deploy-only
#   ./scripts/ship.sh --no-deploy "commit message"
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEPLOY_ONLY=false
NO_DEPLOY=false
COMMIT_MSG=""

usage() {
  cat <<'EOF'
Usage: ./scripts/ship.sh [options] "commit message"

Options:
  --deploy-only   Skip commit/push; only run Firebase deploy
  --no-deploy     Commit and push; skip Firebase deploy (CI may still deploy)
  -h, --help      Show this help

Examples:
  ./scripts/ship.sh "Fix trade plan symbol layout"
  ./scripts/ship.sh --deploy-only
  ./scripts/ship.sh --no-deploy "Backend scheduler tweak"
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deploy-only)
      DEPLOY_ONLY=true
      shift
      ;;
    --no-deploy)
      NO_DEPLOY=true
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$COMMIT_MSG" ]]; then
        COMMIT_MSG="$COMMIT_MSG $1"
      else
        COMMIT_MSG="$1"
      fi
      shift
      ;;
  esac
done

log() {
  printf '\n▸ %s\n' "$1"
}

exclude_from_commit() {
  local path
  for path in "$@"; do
    if git ls-files --error-unmatch "$path" >/dev/null 2>&1 || [[ -e "$path" ]]; then
      git reset -q HEAD -- "$path" 2>/dev/null || true
    fi
  done
}

if [[ "$DEPLOY_ONLY" == false ]]; then
  if [[ -z "$COMMIT_MSG" ]]; then
    echo "Error: commit message is required (unless using --deploy-only)." >&2
    usage
    exit 1
  fi

  log "Staging changes"
  git add -A
  exclude_from_commit \
    firebase-debug.log \
    frontend/firebase-debug.log \
    backend/.env \
    backend/bin \
    frontend/dist \
    frontend/node_modules \
    frontend/.angular \
    functions \
    python-worker/.env \
    python-worker/.venv

  if git diff --cached --quiet; then
    log "Nothing to commit"
  else
    log "Committing"
    git diff --cached --stat
    git commit -m "$COMMIT_MSG"
  fi

  BRANCH="$(git branch --show-current)"
  log "Pushing to origin/$BRANCH"
  git push origin "$BRANCH"
else
  log "Skipping commit and push (--deploy-only)"
fi

if [[ "$NO_DEPLOY" == true ]]; then
  log "Skipping deploy (--no-deploy)"
  exit 0
fi

log "Deploying frontend to Firebase"
(
  cd frontend
  npm run deploy
)

log "Done"
