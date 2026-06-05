#!/usr/bin/env bash
# Proof that the SAME stream-processor runner runs INBOUND in a real browser tab.
#
# Loads the stream page in a headless Chrome for Testing (never the user's Chrome,
# no remote-debugging prompts), waits for the browser-hosted processor to subscribe
# over capnweb, and asserts it received events from the stream (the in-memory
# `__receivedEventCount`, independent of the local SQLite projection).
#
# Usage: WORKER_URL=https://stream-staging-area.<acct>.workers.dev scripts/browser-inbound-proof.sh
#        (defaults to the deployed worker)
set -euo pipefail

URL="${WORKER_URL:-https://stream-staging-area.iterate-dev-preview.workers.dev}"
PORT="${CDP_PORT:-9444}"
BIN="$HOME/.agent-browser/browsers/chrome-149.0.7827.54/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"

if ! curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
  echo "launching headless Chrome for Testing on :$PORT"
  nohup "$BIN" --headless=new --remote-debugging-port="$PORT" --user-data-dir=/tmp/ab-own about:blank >/tmp/ab-own.log 2>&1 &
  disown
  sleep 3
fi

export AGENT_BROWSER_AUTO_CONNECT=0
path="proof-$(date +%s)"
agent-browser --cdp "$PORT" open "$URL/streams/$path" >/dev/null 2>&1
agent-browser --cdp "$PORT" wait 9000 >/dev/null 2>&1

result=$(agent-browser --cdp "$PORT" eval 'JSON.stringify({ status: document.querySelector("[data-testid=stream-status]")?.textContent, received: globalThis.__receivedEventCount ?? 0 })' 2>&1 | tail -1)
echo "browser result: $result"

received=$(printf '%s' "$result" | grep -oE 'received[^0-9]*[0-9]+' | grep -oE '[0-9]+$' || echo 0)
if [ "${received:-0}" -ge 1 ]; then
  echo "PASS: browser-hosted processor received $received events inbound from $URL"
else
  echo "FAIL: browser-hosted processor received no events"
  exit 1
fi
