#!/usr/bin/env bash
set -euo pipefail

INIT_LOG="/tmp/gateway-init.log"
FLOW_LOG="/tmp/gateway-flow.log"
DNS_LOG="/tmp/gateway-dns.log"
READY_FILE="/tmp/gateway-ready"

SANDBOX_IP="${SANDBOX_IP:?missing SANDBOX_IP}"
MITM_IP="${MITM_IP:?missing MITM_IP}"
GATEWAY_IP="${GATEWAY_IP:?missing GATEWAY_IP}"
SUBNET_CIDR="${SUBNET_CIDR:-172.30.0.0/24}"
MITM_PORT="${EGRESS_MITM_PORT:-18080}"
UPSTREAM_IP="${UPSTREAM_IP:-}"

log() {
  printf "%s %s\n" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$INIT_LOG"
}

: >"$INIT_LOG"
: >"$FLOW_LOG"
: >"$DNS_LOG"
rm -f "$READY_FILE"

log "START host=$(hostname) sandbox_ip=$SANDBOX_IP mitm_ip=$MITM_IP gateway_ip=$GATEWAY_IP"

sysctl -w net.ipv4.ip_forward=1 >>"$INIT_LOG" 2>&1 || log "WARN ip_forward_sysctl_failed"

cat >/tmp/dnsmasq.conf <<CFG
port=53
listen-address=0.0.0.0
bind-interfaces
log-queries
log-facility=$DNS_LOG
no-resolv
server=1.1.1.1
server=8.8.8.8
CFG

if [ -n "$UPSTREAM_IP" ]; then
  {
    echo "address=/public-http/$UPSTREAM_IP"
    echo "address=/public-http.local/$UPSTREAM_IP"
  } >> /tmp/dnsmasq.conf
fi

/usr/sbin/dnsmasq --keep-in-foreground --conf-file=/tmp/dnsmasq.conf >>"$INIT_LOG" 2>&1 &
DNSMASQ_PID="$!"
log "dnsmasq_pid=$DNSMASQ_PID"

iptables -F
iptables -t nat -F
iptables -P FORWARD ACCEPT

iptables -t nat -A PREROUTING -s "$SANDBOX_IP" -p udp --dport 53 -j DNAT --to-destination "$GATEWAY_IP":53
iptables -t nat -A PREROUTING -s "$SANDBOX_IP" -p tcp --dport 53 -j DNAT --to-destination "$GATEWAY_IP":53
iptables -t nat -A PREROUTING -s "$SANDBOX_IP" -p tcp --dport "$MITM_PORT" -j DNAT --to-destination "$MITM_IP":"$MITM_PORT"
iptables -t nat -A PREROUTING -s "$SANDBOX_IP" -p tcp --dport 80 -j DNAT --to-destination "$MITM_IP":"$MITM_PORT"
iptables -t nat -A PREROUTING -s "$SANDBOX_IP" -p tcp --dport 443 -j DNAT --to-destination "$MITM_IP":"$MITM_PORT"

iptables -t nat -A POSTROUTING -s "$SUBNET_CIDR" -o eth0 -j MASQUERADE

iptables-save >/tmp/gateway-iptables.txt
log "iptables_configured=ok"

# Metadata logging for all sandbox TCP/UDP traffic that reaches gateway.
tcpdump -i any -n -l "(tcp or udp) and src $SANDBOX_IP" >>"$FLOW_LOG" 2>&1 &
TCPDUMP_PID="$!"
log "tcpdump_pid=$TCPDUMP_PID"

touch "$READY_FILE"
log "READY"

tail -f /dev/null
