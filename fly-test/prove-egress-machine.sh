#!/bin/sh
set -eu

PROOF_FILE="/tmp/egress-proof.txt"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$PROOF_FILE"
}

run_curl_test() {
  label="$1"
  target="$2"
  family="$3"
  log "BEGIN ${label} target=${target}"
  set +e
  output="$(curl -sS -I --max-time 8 "$family" "$target" 2>&1)"
  status="$?"
  set -e
  if [ "$status" -eq 0 ]; then
    log "RESULT ${label}=SUCCESS"
    return 0
  fi

  log "RESULT ${label}=FAIL status=${status}"
  printf '%s\n' "$output" | sed 's/^/CURL /' | tee -a "$PROOF_FILE"
  return 0
}

: >"$PROOF_FILE"
log "START host=$(hostname) region=${PROOF_REGION:-unknown}"

run_curl_test "pre_block_https_example_v4" "https://example.com" "-4"
run_curl_test "pre_block_https_example_v6" "https://example.com" "-6"
run_curl_test "pre_block_https_fly_v4" "https://api.fly.io" "-4"
run_curl_test "pre_block_https_fly_v6" "https://api.fly.io" "-6"
run_curl_test "pre_block_http_cloudflare_dns_v4" "http://1.1.1.1" "-4"

log "APPLY iptables OUTPUT DROP"
if ! iptables -P OUTPUT DROP >>"$PROOF_FILE" 2>&1; then
  log "ERROR iptables_output_policy_failed"
  tail -f /dev/null
fi
iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT >>"$PROOF_FILE" 2>&1 || true
iptables -S | sed 's/^/IPTABLES /' | tee -a "$PROOF_FILE"
if command -v ip6tables >/dev/null 2>&1; then
  if ! ip6tables -P OUTPUT DROP >>"$PROOF_FILE" 2>&1; then
    log "ERROR ip6tables_output_policy_failed"
    tail -f /dev/null
  fi
  ip6tables -A OUTPUT -d ::1/128 -j ACCEPT >>"$PROOF_FILE" 2>&1 || true
  ip6tables -S | sed 's/^/IP6TABLES /' | tee -a "$PROOF_FILE"
fi

run_curl_test "post_block_https_example_v4" "https://example.com" "-4"
run_curl_test "post_block_https_example_v6" "https://example.com" "-6"
run_curl_test "post_block_https_fly_v4" "https://api.fly.io" "-4"
run_curl_test "post_block_https_fly_v6" "https://api.fly.io" "-6"
run_curl_test "post_block_http_cloudflare_dns_v4" "http://1.1.1.1" "-4"

log "DONE"

tail -f /dev/null
