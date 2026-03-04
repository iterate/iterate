# syntax=docker/dockerfile:1

ARG OPENOBSERVE_IMAGE=public.ecr.aws/zinclabs/openobserve:latest@sha256:88e244620dcb3786b0d04a0339fc9de8342568c6c91e4e09c6e8fd93d2eb9efd
ARG OTELCOL_IMAGE=otel/opentelemetry-collector-contrib:latest@sha256:f6e429c1052ab50f85a7afa5f7e32f25931697751622b0e1f453d10f79a1df3c
ARG CLICKSTACK_IMAGE=clickhouse/clickstack-local:2@sha256:9d65a40b1376f15455c0b02be1f1ce728f38f47d6aec302528a4b35ecc6a59ec

FROM ${OPENOBSERVE_IMAGE} AS openobserve
FROM ${OTELCOL_IMAGE} AS otelcol
FROM ${CLICKSTACK_IMAGE} AS clickstack

FROM node:24-trixie-slim

ARG CADDY_VERSION=2.11.1
ARG FRP_VERSION=0.65.0
ARG PI_CODING_AGENT_VERSION=0.52.8
ARG SANDBOX_CODEX_VERSION=0.98.0
ARG SANDBOX_OPENCODE_VERSION=1.2.15
ARG TARGETARCH
ARG GIT_SHA=unknown

ENV ITERATE_REPO=/home/iterate/src/github.com/iterate/iterate

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    dnsmasq \
    fd-find \
    git \
    gh \
    iptables \
    jq \
    less \
    libcap2-bin \
    openssh-client \
    procps \
    ripgrep \
    rsync \
    sqlite3 \
    sudo \
    tini \
    tmux \
    unzip \
    util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "$(which fdfind)" /usr/local/bin/fd

# Route *.iterate.localhost to loopback for in-container service discovery.
# See jonasland/hosts-and-routing.md for routing model and rationale.
RUN printf 'address=/.iterate.localhost/127.0.0.1\n' > /etc/dnsmasq.d/iterate-localhost.conf

RUN curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin caddy && \
    chmod +x /usr/local/bin/caddy && \
    setcap cap_net_bind_service=+ep /usr/local/bin/caddy

RUN case "${TARGETARCH}" in \
      amd64) FRP_ARCH=amd64 ;; \
      arm64) FRP_ARCH=arm64 ;; \
      *) echo "Unsupported TARGETARCH for frp: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz" \
    -o /tmp/frp.tar.gz && \
    tar -xzf /tmp/frp.tar.gz -C /tmp && \
    mv "/tmp/frp_${FRP_VERSION}_linux_${FRP_ARCH}/frps" /usr/local/bin/frps && \
    chmod +x /usr/local/bin/frps && \
    rm -rf /tmp/frp.tar.gz "/tmp/frp_${FRP_VERSION}_linux_${FRP_ARCH}"

RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

RUN npm install -g \
    @mariozechner/pi-coding-agent@${PI_CODING_AGENT_VERSION} \
    @openai/codex@${SANDBOX_CODEX_VERSION} \
    tsx \
    serve \
    && npm cache clean --force
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version ${SANDBOX_OPENCODE_VERSION}

COPY --from=openobserve /openobserve /usr/local/bin/openobserve
COPY --from=otelcol /otelcol-contrib /usr/local/bin/otelcol-contrib
COPY --from=clickstack / /opt/clickstack-root

RUN groupadd -g 1001 iterate && \
    useradd -m -u 1001 -g iterate -s /bin/bash iterate && \
    echo 'iterate ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/iterate && \
    chmod 0440 /etc/sudoers.d/iterate && \
    mkdir -p \
      "$ITERATE_REPO" \
      /var/lib/jonasland \
      /var/lib/openobserve \
      /var/log/pidnap && \
    chown -R iterate:iterate /home/iterate /var/lib/jonasland /var/lib/openobserve /var/log/pidnap

USER iterate

ENV PATH="/home/iterate/.iterate/bin:/home/iterate/.local/bin:/home/iterate/.opencode/bin:/home/iterate/.npm-global/bin:$PATH"

WORKDIR $ITERATE_REPO

# Dependency-manifest layer (source changes should not invalidate this).
COPY --chown=iterate:iterate package.json pnpm-lock.yaml pnpm-workspace.yaml $ITERATE_REPO/
COPY --chown=iterate:iterate services/registry-service/package.json $ITERATE_REPO/services/registry-service/package.json
COPY --chown=iterate:iterate services/events-service/package.json $ITERATE_REPO/services/events-service/package.json
COPY --chown=iterate:iterate services/example/package.json $ITERATE_REPO/services/example/package.json
COPY --chown=iterate:iterate services/home-service/package.json $ITERATE_REPO/services/home-service/package.json
COPY --chown=iterate:iterate services/docs-service/package.json $ITERATE_REPO/services/docs-service/package.json
COPY --chown=iterate:iterate services/outerbase-service/package.json $ITERATE_REPO/services/outerbase-service/package.json
COPY --chown=iterate:iterate services/egress-service/package.json $ITERATE_REPO/services/egress-service/package.json
COPY --chown=iterate:iterate packages/pidnap/package.json $ITERATE_REPO/packages/pidnap/package.json
COPY --chown=iterate:iterate services/registry-contract/package.json $ITERATE_REPO/services/registry-contract/package.json
COPY --chown=iterate:iterate services/events-contract/package.json $ITERATE_REPO/services/events-contract/package.json
COPY --chown=iterate:iterate services/example-contract/package.json $ITERATE_REPO/services/example-contract/package.json
COPY --chown=iterate:iterate packages/shared/package.json $ITERATE_REPO/packages/shared/package.json
COPY --chown=iterate:iterate packages/ui/package.json $ITERATE_REPO/packages/ui/package.json
COPY --chown=iterate:iterate jonasland/sandbox/package.json $ITERATE_REPO/jonasland/sandbox/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts \
    --filter pidnap \
    --filter @iterate-com/jonasland-sandbox \
    --filter @iterate-com/registry-service \
    --filter @iterate-com/events-service \
    --filter @iterate-com/example \
    --filter @iterate-com/home-service \
    --filter @iterate-com/docs-service \
    --filter @iterate-com/outerbase-service \
    --filter @iterate-com/egress-service \
    --filter @iterate-com/registry-contract \
    --filter @iterate-com/events-contract \
    --filter @iterate-com/example-contract \
    --filter @iterate-com/shared \
    --filter @iterate-com/ui
RUN pnpm -r rebuild better-sqlite3 esbuild protobufjs

# Source payload layer.
COPY --chown=iterate:iterate . $ITERATE_REPO
RUN if [ -f .git ]; then rm .git && mkdir .git; fi

RUN chmod +x \
    "$ITERATE_REPO/jonasland/sandbox/start.sh" \
    "$ITERATE_REPO/jonasland/sandbox/clickstack-launcher.sh" \
    "$ITERATE_REPO/jonasland/sandbox/sync-home-skeleton.sh" \
    "$ITERATE_REPO/jonasland/sandbox/providers/docker/sync-repo-from-host.sh"

# Keep a functional git repo inside image.
RUN git init && \
    git config user.email "iterate-bot@noreply.iterate.com" && \
    git config user.name "iterate-bot" && \
    git add . && \
    git commit -m "snapshot ${GIT_SHA}" && \
    git branch -M main

EXPOSE 80
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=20 \
  CMD curl -fsS http://127.0.0.1/healthz >/dev/null || exit 1

ENV GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/home/iterate/src/github.com/iterate/iterate/jonasland/sandbox/start.sh"]
