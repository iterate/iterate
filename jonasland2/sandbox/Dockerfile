# syntax=docker/dockerfile:1

FROM public.ecr.aws/zinclabs/openobserve:latest AS openobserve

FROM node:24-trixie-slim

ARG NOMAD_VERSION=1.11.2
ARG CONSUL_VERSION=1.22.4
ARG TARGETARCH

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates caddy curl iptables tini unzip && \
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

WORKDIR /app
COPY --from=openobserve /openobserve /usr/local/bin/openobserve
COPY package.json /app/package.json
COPY apps /app/apps
RUN npm install --omit=dev --no-audit --no-fund
RUN mkdir -p /app/node_modules/@jonasland2 && \
    ln -sf /app/apps/events-contract /app/node_modules/@jonasland2/events-contract && \
    ln -sf /app/apps/events-service /app/node_modules/@jonasland2/events-service
COPY caddy/Caddyfile /etc/jonasland2/caddy/Caddyfile
COPY nomad/base.hcl /etc/jonasland2/nomad/base.hcl
COPY nomad/jobs/*.nomad.hcl /etc/jonasland2/nomad/jobs/
COPY egress-server.mjs /app/egress-server.mjs
COPY start.sh /etc/jonasland2/start.sh
RUN chmod +x /etc/jonasland2/start.sh && \
    mkdir -p /nomad-data /consul-data /caddy-data /var/lib/openobserve && \
    chown -R node:node /caddy-data /var/lib/openobserve

EXPOSE 53 80 443 8500 4646 2019 5080 19000 19010
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/etc/jonasland2/start.sh"]
