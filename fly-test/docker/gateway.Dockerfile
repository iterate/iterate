FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  dnsmasq \
  iproute2 \
  iptables \
  procps \
  tcpdump \
  && rm -rf /var/lib/apt/lists/*

COPY docker/gateway-entrypoint.sh /docker/gateway-entrypoint.sh
RUN chmod +x /docker/gateway-entrypoint.sh

ENTRYPOINT ["/bin/bash", "/docker/gateway-entrypoint.sh"]
