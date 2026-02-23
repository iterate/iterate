# syntax=docker/dockerfile:1

FROM golang:1.24-alpine AS caddy-builder
ARG CADDY_VERSION=v2.10.2
RUN go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest
RUN xcaddy build "${CADDY_VERSION}" --with github.com/Inpher/caddy-consul --output /tmp/caddy-with-consul

FROM node:24-alpine
ARG NOMAD_VERSION=1.10.4
ARG CONSUL_VERSION=1.20.4

RUN apk add --no-cache bash ca-certificates curl iproute2 iptables su-exec unzip

RUN curl -fsSL "https://releases.hashicorp.com/nomad/${NOMAD_VERSION}/nomad_${NOMAD_VERSION}_linux_amd64.zip" -o /tmp/nomad.zip && \
    unzip -q /tmp/nomad.zip -d /usr/local/bin && \
    chmod +x /usr/local/bin/nomad && \
    rm -f /tmp/nomad.zip

RUN curl -fsSL "https://releases.hashicorp.com/consul/${CONSUL_VERSION}/consul_${CONSUL_VERSION}_linux_amd64.zip" -o /tmp/consul.zip && \
    unzip -q /tmp/consul.zip -d /usr/local/bin && \
    chmod +x /usr/local/bin/consul && \
    rm -f /tmp/consul.zip

COPY --from=caddy-builder /tmp/caddy-with-consul /usr/local/bin/caddy-with-consul
RUN chmod +x /usr/local/bin/caddy-with-consul

RUN adduser -D -H -u 1000 caddy

RUN mkdir -p /etc/jonasland/nomad/jobs /etc/jonasland/caddy /etc/jonasland/services /etc/jonasland/scripts /var/lib/nomad /var/lib/caddy
COPY jonasland/sandbox/nomad/base.hcl /etc/jonasland/nomad/base.hcl
COPY jonasland/sandbox/nomad/jobs/*.nomad.hcl /etc/jonasland/nomad/jobs/
COPY jonasland/sandbox/caddy/bootstrap.caddyfile /etc/jonasland/caddy/bootstrap.caddyfile
COPY jonasland/sandbox/caddy/global-config.json /etc/jonasland/caddy/global-config.json
COPY jonasland/sandbox/services/ /etc/jonasland/services/
COPY jonasland/sandbox/scripts/ /etc/jonasland/scripts/
RUN find /etc/jonasland/scripts -name "*.sh" -exec chmod +x {} \;

CMD ["nomad", "agent", "-dev", "-config=/etc/jonasland/nomad/base.hcl"]
