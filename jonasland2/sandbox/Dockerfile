# syntax=docker/dockerfile:1

FROM public.ecr.aws/zinclabs/openobserve:latest AS openobserve
FROM otel/opentelemetry-collector-contrib:latest AS otelcol
FROM node:24-trixie-slim AS outerbase_studio

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/outerbase
RUN git clone --depth 1 https://github.com/outerbase/studio .
RUN npm ci --no-audit --no-fund
RUN npm run build

FROM node:24-trixie-slim

ARG NOMAD_VERSION=1.11.2
ARG CONSUL_VERSION=1.22.4
ARG CADDY_VERSION=2.11.1
ARG TARGETARCH

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl iptables tini unzip && \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    curl -fsSL "https://releases.hashicorp.com/nomad/${NOMAD_VERSION}/nomad_${NOMAD_VERSION}_linux_${arch}.zip" -o /tmp/nomad.zip; \
    mkdir -p /tmp/nomad-extract; \
    unzip -qq /tmp/nomad.zip -d /tmp/nomad-extract; \
    install -m 0755 /tmp/nomad-extract/nomad /usr/local/bin/nomad; \
    rm -rf /tmp/nomad.zip /tmp/nomad-extract

RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    curl -fsSL "https://releases.hashicorp.com/consul/${CONSUL_VERSION}/consul_${CONSUL_VERSION}_linux_${arch}.zip" -o /tmp/consul.zip; \
    mkdir -p /tmp/consul-extract; \
    unzip -qq /tmp/consul.zip -d /tmp/consul-extract; \
    install -m 0755 /tmp/consul-extract/consul /usr/local/bin/consul; \
    rm -rf /tmp/consul.zip /tmp/consul-extract

RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${arch}.tar.gz" \
      | tar -xz -C /usr/local/bin caddy; \
    chmod +x /usr/local/bin/caddy

WORKDIR /app
COPY --from=openobserve /openobserve /usr/local/bin/openobserve
COPY --from=otelcol /otelcol-contrib /usr/local/bin/otelcol-contrib
COPY --from=outerbase_studio /tmp/outerbase/.next/standalone /opt/outerbase
COPY --from=outerbase_studio /tmp/outerbase/public /opt/outerbase/public
COPY --from=outerbase_studio /tmp/outerbase/.next/static /opt/outerbase/.next/static
COPY sandbox/package.json /app/package.json
COPY apps /app/apps
COPY packages /app/packages
RUN npm install --omit=dev --no-audit --no-fund
RUN mkdir -p /app/node_modules/@jonasland2 && \
    ln -sf /app/apps/events-contract /app/node_modules/@jonasland2/events-contract && \
    ln -sf /app/apps/events-service /app/node_modules/@jonasland2/events-service && \
    ln -sf /app/apps/orders-contract /app/node_modules/@jonasland2/orders-contract && \
    ln -sf /app/apps/orders-service /app/node_modules/@jonasland2/orders-service && \
    ln -sf /app/apps/orpc-shared /app/node_modules/@jonasland2/orpc-shared && \
    ln -sf /app/packages/shared /app/node_modules/@jonasland2/shared
COPY sandbox/caddy/Caddyfile /etc/jonasland2/caddy/Caddyfile
COPY sandbox/nomad/base.hcl /etc/jonasland2/nomad/base.hcl
COPY sandbox/nomad/jobs/*.nomad.hcl /etc/jonasland2/nomad/jobs/
COPY sandbox/otel-collector/config.yaml /etc/jonasland2/otel-collector/config.yaml
COPY sandbox/egress-server.mjs /app/egress-server.mjs
COPY sandbox/start.sh /etc/jonasland2/start.sh
RUN chmod +x /etc/jonasland2/start.sh && \
    mkdir -p /nomad-data /consul-data /caddy-data /var/lib/openobserve /var/lib/jonasland2 /otel-collector-data && \
    chown -R node:node /caddy-data /var/lib/openobserve /var/lib/jonasland2

EXPOSE 53 80 443 8500 4646 2019 4317 4318 5080 13133 19000 19010 19020 19040
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/etc/jonasland2/start.sh"]
