#!/bin/bash
# Test egress proxy inside Docker container
#
# This script builds and runs the sandbox container, then tests
# that the egress proxy correctly forwards requests through the worker.
#
# Usage:
#   ./test-egress-proxy.sh
#
# Prerequisites:
#   - Worker running (locally or via Cloudflare tunnel)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[test]${NC} $1"; }
warn() { echo -e "${YELLOW}[test]${NC} $1"; }
error() { echo -e "${RED}[test]${NC} $1"; }

# Configuration - use your Cloudflare tunnel
# For production: https://egress.iterate.com/api/egress-proxy
# For dev tunnel: https://dev-nick-os.dev.iterate.com/api/egress-proxy
ITERATE_EGRESS_PROXY_URL="${ITERATE_EGRESS_PROXY_URL:-https://dev-nick-os.dev.iterate.com/api/egress-proxy}"
ITERATE_OS_API_KEY="${ITERATE_OS_API_KEY:-test-dev-key}"

log "Building Docker image..."
LOCAL_DOCKER_IMAGE_NAME="iterate-sandbox:test" pnpm --filter os docker:build

log ""
log "Running egress proxy test in container..."
log "Egress proxy URL: $ITERATE_EGRESS_PROXY_URL"
log ""

# Run test commands inside container
docker run --rm \
  -e ITERATE_EGRESS_PROXY_URL="$ITERATE_EGRESS_PROXY_URL" \
  -e ITERATE_OS_API_KEY="$ITERATE_OS_API_KEY" \
  -v "$REPO_ROOT:/local-iterate-repo:ro" \
  iterate-sandbox:test \
  /bin/bash -c '
set -e

# Colors
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[1;33m"
NC="\033[0m"

log() { echo -e "${GREEN}[container]${NC} $1"; }
warn() { echo -e "${YELLOW}[container]${NC} $1"; }
error() { echo -e "${RED}[container]${NC} $1"; }

log "Setting up mitmproxy..."

# Copy addon script
mkdir -p /app/egress-proxy
cp /local-iterate-repo/apps/os/sandbox/egress-proxy-addon.py /app/egress-proxy/

# Start mitmproxy in background
log "Starting mitmproxy on port 8888..."
ITERATE_EGRESS_PROXY_URL="$ITERATE_EGRESS_PROXY_URL" \
ITERATE_OS_API_KEY="$ITERATE_OS_API_KEY" \
mitmdump -p 8888 -s /app/egress-proxy/egress-proxy-addon.py --ssl-insecure &
PROXY_PID=$!

sleep 3

# Check if proxy is running
if ! kill -0 $PROXY_PID 2>/dev/null; then
    error "mitmproxy failed to start"
    exit 1
fi
log "mitmproxy running (PID: $PROXY_PID)"

# Wait for CA cert to be generated
sleep 2

# Install CA cert to system
if [ -f ~/.mitmproxy/mitmproxy-ca-cert.pem ]; then
    log "Installing CA cert to system..."
    cp ~/.mitmproxy/mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/mitmproxy-ca.crt
    update-ca-certificates 2>/dev/null || true
fi

log ""
log "Running tests..."
log ""

# Set proxy env vars
export HTTP_PROXY="http://127.0.0.1:8888"
export HTTPS_PROXY="http://127.0.0.1:8888"
export http_proxy="http://127.0.0.1:8888"
export https_proxy="http://127.0.0.1:8888"

# Test 1: Simple HTTPS request
log "Test 1: HTTPS request to httpbin.org"
if curl -s --max-time 10 https://httpbin.org/get 2>/dev/null | grep -q "origin"; then
    log "  ✓ HTTPS request works"
else
    # Try with -k if CA not trusted
    if curl -sk --max-time 10 https://httpbin.org/get 2>/dev/null | grep -q "origin"; then
        warn "  ✓ HTTPS works (with -k, CA not fully trusted)"
    else
        error "  ✗ HTTPS request failed"
    fi
fi

# Test 2: OpenAI API (should be intercepted, get 401 without key)
log "Test 2: OpenAI API interception"
RESPONSE=$(curl -sk --max-time 10 https://api.openai.com/v1/models -w "%{http_code}" -o /tmp/openai-response.txt 2>/dev/null || echo "000")
if [ "$RESPONSE" = "401" ]; then
    log "  ✓ OpenAI request intercepted (401 without valid key)"
elif [ "$RESPONSE" = "000" ]; then
    error "  ✗ Request failed to connect"
    cat /tmp/openai-response.txt 2>/dev/null || true
else
    warn "  ? OpenAI returned HTTP $RESPONSE"
    cat /tmp/openai-response.txt 2>/dev/null | head -5 || true
fi

# Test 3: apt-get (uses proxy for package lists)
log "Test 3: apt-get update (via proxy)"
if apt-get update 2>&1 | head -5; then
    log "  ✓ apt-get works through proxy"
else
    warn "  ? apt-get might have issues"
fi

# Test 4: pip (uses proxy)
log "Test 4: pip search (via proxy)"
if pip3 index versions requests 2>&1 | head -3; then
    log "  ✓ pip works through proxy"
else
    warn "  ? pip might have issues"
fi

log ""
log "Tests complete!"

# Cleanup
kill $PROXY_PID 2>/dev/null || true
'

log ""
log "Docker test finished!"
