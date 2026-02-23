# syntax=docker/dockerfile:1

ARG CADDY_VERSION=2.11.1
FROM caddy:${CADDY_VERSION} AS caddy-bin

FROM node:24-bookworm-slim
ARG NOMAD_VERSION=1.11.2
ARG CONSUL_VERSION=1.22.4
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    gosu \
    iproute2 \
    iptables \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://releases.hashicorp.com/nomad/${NOMAD_VERSION}/nomad_${NOMAD_VERSION}_linux_${TARGETARCH}.zip" -o /tmp/nomad.zip && \
    mkdir -p /tmp/nomad-extract && \
    unzip -q /tmp/nomad.zip -d /tmp/nomad-extract && \
    install -m 0755 /tmp/nomad-extract/nomad /usr/local/bin/nomad && \
    rm -rf /tmp/nomad.zip /tmp/nomad-extract

RUN curl -fsSL "https://releases.hashicorp.com/consul/${CONSUL_VERSION}/consul_${CONSUL_VERSION}_linux_${TARGETARCH}.zip" -o /tmp/consul.zip && \
    mkdir -p /tmp/consul-extract && \
    unzip -q /tmp/consul.zip -d /tmp/consul-extract && \
    install -m 0755 /tmp/consul-extract/consul /usr/local/bin/consul && \
    rm -rf /tmp/consul.zip /tmp/consul-extract

COPY --from=caddy-bin /usr/bin/caddy /usr/local/bin/caddy
RUN chmod +x /usr/local/bin/caddy

RUN mkdir -p /etc/jonasland/nomad/jobs /etc/jonasland/caddy /etc/jonasland/services /etc/jonasland/scripts /var/lib/nomad /var/lib/caddy
COPY jonasland/sandbox/nomad/base.hcl /etc/jonasland/nomad/base.hcl
COPY jonasland/sandbox/nomad/jobs/*.nomad.hcl /etc/jonasland/nomad/jobs/
COPY jonasland/sandbox/caddy/Caddyfile /etc/jonasland/caddy/Caddyfile
COPY jonasland/sandbox/services/ /etc/jonasland/services/
COPY jonasland/sandbox/scripts/ /etc/jonasland/scripts/
RUN find /etc/jonasland/scripts -name "*.sh" -exec chmod +x {} \;
RUN chown -R node:node /var/lib/caddy

CMD ["nomad", "agent", "-dev", "-config=/etc/jonasland/nomad/base.hcl"]
