# syntax=docker/dockerfile:1

FROM debian:bookworm-slim

ARG NOMAD_VERSION=1.11.2
ARG CONSUL_VERSION=1.22.4
ARG CADDY_VERSION=2.11.1
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tini \
    unzip \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://releases.hashicorp.com/nomad/${NOMAD_VERSION}/nomad_${NOMAD_VERSION}_linux_${TARGETARCH}.zip" -o /tmp/nomad.zip && \
    mkdir -p /tmp/nomad-extract && \
    unzip -qq /tmp/nomad.zip -d /tmp/nomad-extract && \
    install -m 0755 /tmp/nomad-extract/nomad /usr/local/bin/nomad && \
    rm -rf /tmp/nomad.zip /tmp/nomad-extract

RUN curl -fsSL "https://releases.hashicorp.com/consul/${CONSUL_VERSION}/consul_${CONSUL_VERSION}_linux_${TARGETARCH}.zip" -o /tmp/consul.zip && \
    mkdir -p /tmp/consul-extract && \
    unzip -qq /tmp/consul.zip -d /tmp/consul-extract && \
    install -m 0755 /tmp/consul-extract/consul /usr/local/bin/consul && \
    rm -rf /tmp/consul.zip /tmp/consul-extract

RUN curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin caddy && \
    chmod +x /usr/local/bin/caddy

RUN mkdir -p /etc/jonasland3/nomad/jobs /etc/jonasland3/caddy /nomad-data /consul-data /caddy-data
COPY jonasland3/sandbox/nomad/base.hcl /etc/jonasland3/nomad/base.hcl
COPY jonasland3/sandbox/nomad/jobs/*.nomad.hcl /etc/jonasland3/nomad/jobs/
COPY jonasland3/sandbox/caddy/Caddyfile /etc/jonasland3/caddy/Caddyfile
COPY jonasland3/sandbox/start.sh /etc/jonasland3/start.sh
RUN chmod +x /etc/jonasland3/start.sh

VOLUME ["/nomad-data", "/consul-data", "/caddy-data"]
EXPOSE 53 80 443 8500 4646 2019

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/etc/jonasland3/start.sh"]
