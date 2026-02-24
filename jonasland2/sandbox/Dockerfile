# syntax=docker/dockerfile:1

FROM public.ecr.aws/zinclabs/openobserve:latest AS openobserve
FROM otel/opentelemetry-collector-contrib:latest AS otelcol
FROM signoz/signoz:v0.112.1 AS signoz
FROM signoz/signoz-otel-collector:v0.142.1 AS signoz_otelcol
FROM clickhouse/clickhouse-server:25.5.6 AS signoz_clickhouse
FROM signoz/zookeeper:3.7.1 AS signoz_zookeeper

FROM node:24-trixie-slim

ARG NOMAD_VERSION=1.11.2
ARG CONSUL_VERSION=1.22.4
ARG CADDY_VERSION=2.11.1
ARG TARGETARCH

RUN apt-get update && \
    apt-get install -y --no-install-recommends bash ca-certificates curl iptables procps tini unzip && \
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
COPY --from=signoz /root/signoz /usr/local/bin/signoz
COPY --from=signoz /root/templates /root/templates
COPY --from=signoz /etc/signoz/web /etc/signoz/web
COPY --from=signoz_otelcol /signoz-otel-collector /usr/local/bin/signoz-otel-collector
COPY --from=signoz_clickhouse /usr/bin/clickhouse /usr/local/bin/clickhouse
COPY --from=signoz_clickhouse /entrypoint.sh /usr/local/bin/clickhouse-entrypoint.sh
COPY --from=signoz_clickhouse /etc/clickhouse-server /etc/clickhouse-server
COPY --from=signoz_zookeeper /opt/bitnami /opt/bitnami
COPY sandbox/package.json /app/package.json
COPY apps /app/apps
COPY packages /app/packages
RUN npm install --omit=dev --no-audit --no-fund
RUN mkdir -p /app/node_modules/@jonasland2 && \
    ln -sf /app/apps/events-contract /app/node_modules/@jonasland2/events-contract && \
    ln -sf /app/apps/events-service /app/node_modules/@jonasland2/events-service && \
    ln -sf /app/apps/home-service /app/node_modules/@jonasland2/home-service && \
    ln -sf /app/apps/orders-contract /app/node_modules/@jonasland2/orders-contract && \
    ln -sf /app/apps/orders-service /app/node_modules/@jonasland2/orders-service && \
    ln -sf /app/apps/orpc-shared /app/node_modules/@jonasland2/orpc-shared && \
    ln -sf /app/packages/shared /app/node_modules/@jonasland2/shared
COPY sandbox/caddy/Caddyfile /etc/jonasland2/caddy/Caddyfile
COPY sandbox/caddy/static/signoz-autologin.html /etc/jonasland2/caddy/static/signoz-autologin.html
COPY sandbox/nomad/base.hcl /etc/jonasland2/nomad/base.hcl
COPY sandbox/nomad/jobs/*.nomad.hcl /etc/jonasland2/nomad/jobs/
COPY sandbox/otel-collector/config.yaml /etc/jonasland2/otel-collector/config.yaml
COPY sandbox/signoz/otel-collector-config.yaml /etc/jonasland2/signoz/otel-collector-config.yaml
COPY sandbox/signoz/clickhouse/cluster.xml /etc/clickhouse-server/config.d/cluster.xml
COPY sandbox/signoz/clickhouse/custom-function.xml /etc/clickhouse-server/config.d/custom-function.xml
COPY sandbox/egress-server.mjs /app/egress-server.mjs
COPY sandbox/outerbase-iframe-service.ts /app/outerbase-iframe-service.ts
COPY sandbox/start.sh /etc/jonasland2/start.sh
RUN chmod +x /etc/jonasland2/start.sh && \
    chmod +x /usr/local/bin/clickhouse-entrypoint.sh && \
    ln -sf /usr/local/bin/clickhouse /usr/local/bin/clickhouse-server && \
    ln -sf /usr/local/bin/clickhouse /usr/local/bin/clickhouse-client && \
    set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    if [ "$arch" = "amd64" ] || [ "$arch" = "x86_64" ]; then harch="amd64"; \
    elif [ "$arch" = "arm64" ] || [ "$arch" = "aarch64" ]; then harch="arm64"; \
    else echo "unsupported architecture for histogram-quantile: $arch" >&2; exit 1; fi; \
    mkdir -p /var/lib/clickhouse/user_scripts; \
    curl -fsSL "https://github.com/SigNoz/signoz/releases/download/histogram-quantile%2Fv0.0.1/histogram-quantile_linux_${harch}.tar.gz" \
      | tar -xz -C /var/lib/clickhouse/user_scripts; \
    mv /var/lib/clickhouse/user_scripts/histogram-quantile /var/lib/clickhouse/user_scripts/histogramQuantile && \
    chmod +x /var/lib/clickhouse/user_scripts/histogramQuantile && \
    groupadd -r zookeeper && \
    useradd -r -g zookeeper zookeeper && \
    mkdir -p /nomad-data /consul-data /caddy-data /var/lib/openobserve /var/lib/jonasland2 /otel-collector-data /var/lib/signoz /bitnami/zookeeper /var/lib/clickhouse /docker-entrypoint-initdb.d && \
    chown -R node:node /caddy-data /var/lib/openobserve /var/lib/jonasland2 /var/lib/signoz && \
    chown -R root:root /var/lib/clickhouse && \
    chown -R zookeeper:zookeeper /bitnami/zookeeper

EXPOSE 53 80 443 8500 2181 4646 2019 4317 4318 5080 8080 8081 8123 9000 9141 13133 14317 14318 14333 14777 19000 19010 19020 19030 19040
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/etc/jonasland2/start.sh"]
