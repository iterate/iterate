# syntax=docker/dockerfile:1

# Pin upstream observability images by digest for reproducible builds.
ARG OPENOBSERVE_IMAGE=public.ecr.aws/zinclabs/openobserve:latest@sha256:88e244620dcb3786b0d04a0339fc9de8342568c6c91e4e09c6e8fd93d2eb9efd
ARG OTELCOL_IMAGE=otel/opentelemetry-collector-contrib:latest@sha256:f6e429c1052ab50f85a7afa5f7e32f25931697751622b0e1f453d10f79a1df3c
ARG CLICKSTACK_IMAGE=clickhouse/clickstack-local:2@sha256:9d65a40b1376f15455c0b02be1f1ce728f38f47d6aec302528a4b35ecc6a59ec

FROM ${OPENOBSERVE_IMAGE} AS openobserve
FROM ${OTELCOL_IMAGE} AS otelcol
FROM ${CLICKSTACK_IMAGE} AS clickstack

# Base runtime for all sandbox processes and developer tooling.
FROM node:24-trixie-slim

# Tool versions are args so we can bump intentionally and audit diffs.
ARG CADDY_VERSION=2.11.1
ARG FRP_VERSION=0.65.0
ARG PI_CODING_AGENT_VERSION=0.52.8
ARG SANDBOX_CLAUDE_CODE_VERSION=2.1.50
ARG SANDBOX_CODEX_VERSION=0.98.0
ARG SANDBOX_OPENCODE_VERSION=1.2.15
ARG TARGETARCH
ARG GIT_SHA=unknown

# Shared repo location used by entrypoint scripts and pidnap config.
ENV ITERATE_REPO=/home/iterate/src/github.com/iterate/iterate

# Install only required OS packages to keep image slim and deterministic.
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

# Install Caddy for local reverse proxy/TLS termination and allow :80/:443 binds.
RUN curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${TARGETARCH}.tar.gz" \
    | tar -xz -C /usr/local/bin caddy && \
    chmod +x /usr/local/bin/caddy && \
    setcap cap_net_bind_service=+ep /usr/local/bin/caddy

# Install frps so the sandbox can expose services through FRP tunnels.
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

# Enable pinned pnpm via corepack for workspace installs.
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

# Install globally-invoked CLIs that run inside the sandbox.
RUN npm install -g \
    @mariozechner/pi-coding-agent@${PI_CODING_AGENT_VERSION} \
    @openai/codex@${SANDBOX_CODEX_VERSION} \
    tsx \
    serve \
    && npm cache clean --force

# Copy observability binaries from their upstream images into one final image.
COPY --from=openobserve /openobserve /usr/local/bin/openobserve
COPY --from=otelcol /otelcol-contrib /usr/local/bin/otelcol-contrib
COPY --from=clickstack / /opt/clickstack-root

# Create runtime users and writable dirs up front so entrypoint stays simple.
# `iterate-egress` exists at build time for iptables owner-based bypass rules.
RUN groupadd -g 1001 iterate && \
    useradd -m -u 1001 -g iterate -s /bin/bash iterate && \
    useradd -M -u 1002 -g iterate -s /usr/sbin/nologin iterate-egress && \
    echo 'iterate ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/iterate && \
    chmod 0440 /etc/sudoers.d/iterate && \
    mkdir -p \
      "$ITERATE_REPO" \
      /var/lib/jonasland \
      /var/lib/openobserve \
      /var/log/pidnap && \
    chown -R iterate:iterate /home/iterate /var/lib/jonasland /var/lib/openobserve /var/log/pidnap

# Install user-scoped CLIs as the `iterate` user so file ownership is correct.
USER iterate

# Ensure user-level bin locations are preferred over system defaults.
ENV PATH="/home/iterate/.iterate/bin:/home/iterate/.local/bin:/home/iterate/.opencode/bin:/home/iterate/.npm-global/bin:$PATH"

RUN curl -fsSL https://opencode.ai/install | bash -s -- --version ${SANDBOX_OPENCODE_VERSION}
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- ${SANDBOX_CLAUDE_CODE_VERSION}

# --- Caddy root CA trust ---
#
# Caddy MITMs all outbound HTTPS via iptables (see entry.sh). It presents
# on-demand self-signed certs for each destination host, signed by a local
# root CA. Every tool inside the container must trust this CA.
#
# Why we start caddy during the build:
#   There's no `caddy generate-ca` command. The only way to produce the root
#   CA is to start caddy with a `tls internal` site. Caddy then:
#   1. Generates the root CA at ~/.local/share/caddy/pki/authorities/local/
#   2. Automatically installs it into the system trust store — both as a
#      symlink in /etc/ssl/certs/ and inside the ca-certificates.crt bundle.
#   We stop caddy immediately after; at runtime it reuses the same PKI data.
#
# Who trusts the system store vs. who needs help:
#   - curl, git, Python, Go, etc. — read the system store (/etc/ssl/certs/)
#     which caddy already updated. Nothing extra needed.
#   - Node.js — ships its own compiled-in root certs and ignores the system
#     store entirely. NODE_EXTRA_CA_CERTS tells Node to load additional CAs
#     on top of its built-in bundle. Without it, pnpm/tsx/etc. fail with
#     UNABLE_TO_GET_ISSUER_CERT_LOCALLY through the caddy MITM.
#

RUN printf ':8443 {\n  tls internal\n  respond "ok" 200\n}\n' > /tmp/caddy-pki.caddyfile && \
    caddy start --config /tmp/caddy-pki.caddyfile --adapter caddyfile && \
    sleep 2 && \
    caddy stop && \
    rm /tmp/caddy-pki.caddyfile && \
    test -f /home/iterate/.local/share/caddy/pki/authorities/local/root.crt
# Runtimes with compiled-in cert bundles that ignore the system store:
#   - Node.js: NODE_EXTRA_CA_CERTS adds the caddy CA on top of built-in roots.
#     NODE_USE_SYSTEM_CA=1 (v22.5+) makes Node read the system store directly.
#   - Python requests: uses certifi (Mozilla bundle) by default; override with
#     REQUESTS_CA_BUNDLE pointing at the system bundle which includes caddy's CA.
# Go, Rust (rustls-native-certs), curl, git all read the system store natively.
ENV NODE_EXTRA_CA_CERTS=/home/iterate/.local/share/caddy/pki/authorities/local/root.crt \
    NODE_USE_SYSTEM_CA=1 \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

# Set workspace root for dependency install and later runtime commands.
WORKDIR $ITERATE_REPO

# Dependency-manifest layer (source changes should not invalidate this).
COPY --chown=iterate:iterate package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then PNPM_ARCH="x64"; else PNPM_ARCH="arm64"; fi && \
    pnpm fetch --config.platform=linux --config.arch="$PNPM_ARCH" --config.libc=glibc

# Source payload layer.
COPY --chown=iterate:iterate --exclude=.git --exclude=.git/ --exclude=node_modules . .
# Worktree checkouts may copy `.git` as a file; normalize to a directory.
RUN if [ -f .git ]; then rm .git && mkdir .git; fi
RUN pnpm install --frozen-lockfile --offline

# Mark startup/support scripts executable at build-time, not runtime.
RUN chmod +x \
    "$ITERATE_REPO/jonasland/sandbox/entry.sh" \
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
# Healthcheck verifies Caddy admin route is serving before sandbox is considered ready.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=20 \
  CMD curl -fsS http://127.0.0.1/__iterate/caddy-health >/dev/null || exit 1

# Stamp image metadata with commit for debugging and provenance.
ENV GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA

# Use tini for signal handling/zombie reaping; entry script starts pidnap.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/home/iterate/src/github.com/iterate/iterate/jonasland/sandbox/entry.sh"]
