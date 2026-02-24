# syntax=docker/dockerfile:1

FROM --platform=linux/amd64 perteus/caddy-ui:3.1.0 AS cpm

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

COPY --from=cpm /app/cpm /usr/local/bin/cpm
COPY --from=cpm /app/web /opt/cpm/web
COPY --from=cpm /app/templates /opt/cpm/templates

RUN mkdir -p /etc/jonasland3/nomad/jobs /etc/jonasland3/caddy /etc/jonasland3/cpm-config /etc/jonasland3/cpm-data /nomad-data /consul-data /caddy-data
COPY jonasland3/sandbox/nomad/base.hcl /etc/jonasland3/nomad/base.hcl
COPY jonasland3/sandbox/nomad/jobs/*.nomad.hcl /etc/jonasland3/nomad/jobs/
COPY jonasland3/sandbox/caddy/Caddyfile /etc/jonasland3/caddy/Caddyfile
COPY jonasland3/sandbox/caddy/Caddyfile /etc/jonasland3/cpm-config/Caddyfile
COPY jonasland3/sandbox/scripts/run-cpm.sh /usr/local/bin/run-cpm
COPY jonasland3/sandbox/start.sh /etc/jonasland3/start.sh
RUN chmod +x /etc/jonasland3/start.sh /usr/local/bin/run-cpm

VOLUME ["/nomad-data", "/consul-data", "/caddy-data"]
EXPOSE 53 80 443 8500 4646 2019 8501

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/etc/jonasland3/start.sh"]
