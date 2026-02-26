#!/usr/bin/env bash
set -euo pipefail

SESSION="iterate_dev"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HEALTH_URL="http://localhost:5173"
HEALTH_TIMEOUT=5

healthcheck() {
  curl -sf -o /dev/null -m "$HEALTH_TIMEOUT" "$HEALTH_URL" 2>/dev/null
}

start_session() {
  echo "Starting tmux session '$SESSION'..."
  tmux new-session -d -s "$SESSION" -c "$REPO_ROOT" "pnpm dev"
  tmux set-option -t "$SESSION" mouse on
  tmux attach -t "$SESSION"
}

kill_session() {
  echo "Killing session '$SESSION'..."
  tmux kill-session -t "$SESSION" 2>/dev/null || true
}

usage() {
  echo "Usage: $0 [--restart|--stop|--status]"
  echo "  (no args)   Start or attach to dev session"
  echo "  --restart   Kill and restart the session"
  echo "  --stop      Kill the session"
  echo "  --status    Print session & healthcheck status"
}

if ! command -v tmux &>/dev/null; then
  echo "tmux not found — install it first" >&2
  exit 1
fi

case "${1:-}" in
  --restart)
    kill_session
    start_session
    ;;
  --stop)
    kill_session
    ;;
  --status)
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      echo "Session: running"
    else
      echo "Session: not running"
    fi
    if healthcheck; then
      echo "Health:  ok ($HEALTH_URL)"
    else
      echo "Health:  unreachable ($HEALTH_URL)"
    fi
    ;;
  --help|-h)
    usage
    ;;
  "")
    if tmux has-session -t "$SESSION" 2>/dev/null; then
      if healthcheck; then
        echo "Healthy — attaching."
        tmux attach -t "$SESSION"
      else
        echo "Unhealthy — restarting."
        kill_session
        start_session
      fi
    else
      start_session
    fi
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
