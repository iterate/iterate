#!/bin/bash
# Test script for egress proxy
#
# Usage:
#   ./test-proxy.sh              # Test proxy passthrough (no worker)
#   ./test-proxy.sh worker       # Test with worker forwarding

set -e

PROXY_PORT=8888
ADDON_PATH="$(dirname "$0")/addon.py"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[test]${NC} $1"; }
warn() { echo -e "${YELLOW}[test]${NC} $1"; }
error() { echo -e "${RED}[test]${NC} $1"; }

# Check if mitmproxy is installed
if ! command -v mitmdump &> /dev/null; then
    error "mitmdump not found. Install with: pip3 install mitmproxy"
    exit 1
fi

# Check if proxy is already running
if nc -z 127.0.0.1 $PROXY_PORT 2>/dev/null; then
    log "Proxy already running on port $PROXY_PORT"
    PROXY_RUNNING=true
else
    PROXY_RUNNING=false
fi

# Test mode
MODE="${1:-passthrough}"

if [ "$MODE" = "worker" ]; then
    log "Testing with worker forwarding..."
    warn "Make sure the OS app is running (pnpm dev in apps/os)"
    
    export ITERATE_OS_BASE_URL="http://localhost:5173"
    export ITERATE_OS_API_KEY="test-dev-key"
else
    log "Testing passthrough mode (no worker)..."
fi

# Start proxy in background if not running
if [ "$PROXY_RUNNING" = "false" ]; then
    log "Starting mitmproxy on port $PROXY_PORT..."
    mitmdump -p $PROXY_PORT -s "$ADDON_PATH" --ssl-insecure &
    PROXY_PID=$!
    sleep 2
    
    cleanup() {
        log "Stopping proxy..."
        kill $PROXY_PID 2>/dev/null || true
    }
    trap cleanup EXIT
fi

log ""
log "Running tests..."
log ""

# Test 1: Simple HTTP request
log "Test 1: HTTP request to httpbin.org"
if curl -s -x http://127.0.0.1:$PROXY_PORT http://httpbin.org/get | grep -q "origin"; then
    log "  ✓ HTTP request works"
else
    error "  ✗ HTTP request failed"
fi

# Test 2: HTTPS request
log "Test 2: HTTPS request to httpbin.org"
if curl -s -x http://127.0.0.1:$PROXY_PORT -k https://httpbin.org/get | grep -q "origin"; then
    log "  ✓ HTTPS request works"
else
    error "  ✗ HTTPS request failed"
fi

# Test 3: Check OpenAI API interception (without valid key, should get 401)
log "Test 3: OpenAI API interception"
RESPONSE=$(curl -s -x http://127.0.0.1:$PROXY_PORT -k https://api.openai.com/v1/models -w "%{http_code}" -o /dev/null)
if [ "$RESPONSE" = "401" ]; then
    log "  ✓ OpenAI request intercepted (got 401 as expected without valid key)"
else
    warn "  ? OpenAI request returned $RESPONSE"
fi

# Test 4: WebSocket (if ws tool is available)
if command -v websocat &> /dev/null; then
    log "Test 4: WebSocket connection"
    if timeout 2 websocat --proxy http://127.0.0.1:$PROXY_PORT wss://echo.websocket.org 2>/dev/null; then
        log "  ✓ WebSocket works"
    else
        warn "  ? WebSocket test inconclusive"
    fi
else
    log "Test 4: WebSocket (skipped - websocat not installed)"
fi

log ""
log "Tests complete!"

if [ "$MODE" = "worker" ]; then
    log ""
    log "Check the OS app logs to see if requests were forwarded correctly."
fi
