# syntax=docker/dockerfile:1

FROM public.ecr.aws/zinclabs/openobserve:latest AS openobserve
FROM otel/opentelemetry-collector-contrib:latest AS otelcol
FROM clickhouse/clickstack-local:2 AS clickstack

FROM node:24-trixie-slim

ARG CADDY_VERSION=2.11.1
ARG TARGETARCH

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    iptables \
    procps \
    tini \
    util-linux \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin caddy && \
    chmod +x /usr/local/bin/caddy

RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

COPY --from=openobserve /openobserve /usr/local/bin/openobserve
COPY --from=otelcol /otelcol-contrib /usr/local/bin/otelcol-contrib
COPY --from=clickstack / /opt/clickstack-root

WORKDIR /opt/pidnap
COPY packages/pidnap/package.json /opt/pidnap/package.json
COPY packages/pidnap/src /opt/pidnap/src
RUN pnpm install --prod --no-frozen-lockfile

WORKDIR /opt/jonasland5-services
COPY jonasland5/services/package.json /opt/jonasland5-services/package.json
COPY jonasland5/services/pnpm-workspace.yaml /opt/jonasland5-services/pnpm-workspace.yaml
COPY jonasland5/services/pnpm-lock.yaml /opt/jonasland5-services/pnpm-lock.yaml
COPY jonasland5/services/shared /opt/jonasland5-services/shared
COPY jonasland5/services/events-contract /opt/jonasland5-services/events-contract
COPY jonasland5/services/events /opt/jonasland5-services/events
COPY jonasland5/services/orders-contract /opt/jonasland5-services/orders-contract
COPY jonasland5/services/orders /opt/jonasland5-services/orders
COPY jonasland5/services/services-contract /opt/jonasland5-services/services-contract
COPY jonasland5/services/services /opt/jonasland5-services/services
RUN pnpm install --prod --frozen-lockfile

WORKDIR /opt/jonasland5-sandbox
COPY jonasland5/sandbox/package.json /opt/jonasland5-sandbox/package.json
COPY jonasland5/sandbox/pnpm-lock.yaml /opt/jonasland5-sandbox/pnpm-lock.yaml
COPY jonasland5/sandbox/services /opt/jonasland5-sandbox/services
RUN pnpm install --prod --frozen-lockfile

RUN mkdir -p \
    /etc/jonasland5/caddy \
    /etc/jonasland5/otel-collector \
    /caddy-data \
    /otel-collector-data \
    /var/lib/openobserve \
    /var/log/pidnap

COPY jonasland5/sandbox/caddy/Caddyfile /etc/jonasland5/caddy/Caddyfile
COPY jonasland5/sandbox/otel-collector/config.yaml /etc/jonasland5/otel-collector/config.yaml
COPY jonasland5/sandbox/clickstack-launcher.sh /etc/jonasland5/clickstack-launcher.sh
COPY jonasland5/sandbox/pidnap.config.ts /etc/jonasland5/pidnap.config.ts
COPY jonasland5/sandbox/start.sh /etc/jonasland5/start.sh
RUN chmod +x /etc/jonasland5/start.sh /etc/jonasland5/clickstack-launcher.sh

VOLUME ["/caddy-data"]
EXPOSE 80
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=20 \
  CMD curl -fsS http://127.0.0.1/ >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/etc/jonasland5/start.sh"]
