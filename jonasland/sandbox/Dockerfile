# syntax=docker/dockerfile:1

# Base runtime for all sandbox processes and developer tooling.
FROM node:24-trixie

# Tool versions are args so we can bump intentionally and audit diffs.
ARG CADDY_VERSION=2.11.2
ARG FRP_VERSION=0.68.0
ARG OPENOBSERVE_VERSION=0.80.0-rc1
ARG OTELCOL_CONTRIB_VERSION=0.148.0
ARG PI_CODING_AGENT_VERSION=0.63.1
ARG SANDBOX_BUN_VERSION=1.3.11
ARG SANDBOX_CLAUDE_CODE_VERSION=2.1.85
ARG SANDBOX_CODEX_VERSION=0.117.0
ARG SANDBOX_GO_VERSION=1.26.1
ARG SANDBOX_GOGCLI_REF=99d957581f61532de08f3847e79f639edad3c68b
ARG SANDBOX_OPENCODE_VERSION=1.3.3
ARG TARGETARCH
ARG GIT_SHA=unknown

# Shared repo location used by entrypoint scripts and pidnap config.
ENV ITERATE_REPO=/home/iterate/src/github.com/iterate/iterate

# Install required OS packages.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    curl -sLf --retry 3 --tlsv1.2 --proto "=https" 'https://packages.doppler.com/public/cli/gpg.DE2A7741A397C129.key' | gpg --dearmor -o /usr/share/keyrings/doppler-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/doppler-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/doppler-archive-keyring.gpg] https://packages.doppler.com/public/cli/deb/debian any-version main" | tee /etc/apt/sources.list.d/doppler-cli.list > /dev/null && \
    apt-get update && apt-get install -y --no-install-recommends \
    bash \
    btop \
    build-essential \
    ca-certificates \
    curl \
    dnsmasq \
    doppler \
    fd-find \
    gh \
    git \
    inotify-tools \
    iptables \
    jq \
    less \
    libcap2-bin \
    libfuse2 \
    locales \
    make \
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
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s $(which fdfind) /usr/local/bin/fd

# Configure UTF-8 locale (required for btop and other CLI tools)
RUN localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Install cloudflared (Cloudflare Tunnel client)
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb" && \
    dpkg -i /tmp/cloudflared.deb && \
    rm /tmp/cloudflared.deb

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

# Install websocat for WebSocket debugging from the container.
RUN case "${TARGETARCH}" in \
      amd64) WSCAT_ARCH=x86_64 ;; \
      arm64) WSCAT_ARCH=aarch64 ;; \
      *) echo "Unsupported TARGETARCH for websocat: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/vi/websocat/releases/latest/download/websocat.${WSCAT_ARCH}-unknown-linux-musl" \
    -o /usr/local/bin/websocat && \
    chmod +x /usr/local/bin/websocat

# Enable pinned pnpm via corepack for workspace installs.
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

# Global npm tools (as root for system-wide access)
RUN npm install -g tsx serve

# Install OpenObserve binary directly (avoid pulling full upstream image layers).
RUN case "${TARGETARCH}" in \
      amd64) OO_ARCH=amd64 ;; \
      arm64) OO_ARCH=arm64 ;; \
      *) echo "Unsupported TARGETARCH for OpenObserve: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://downloads.openobserve.ai/releases/openobserve/v${OPENOBSERVE_VERSION}/openobserve-v${OPENOBSERVE_VERSION}-linux-${OO_ARCH}.tar.gz" \
      -o /tmp/openobserve.tar.gz && \
    tar -xzf /tmp/openobserve.tar.gz -C /tmp && \
    install -m 0755 /tmp/openobserve /usr/local/bin/openobserve && \
    rm -f /tmp/openobserve.tar.gz /tmp/openobserve

# Install OpenTelemetry Collector Contrib binary directly.
RUN case "${TARGETARCH}" in \
      amd64) OTEL_ARCH=amd64 ;; \
      arm64) OTEL_ARCH=arm64 ;; \
      *) echo "Unsupported TARGETARCH for otelcol-contrib: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTELCOL_CONTRIB_VERSION}/otelcol-contrib_${OTELCOL_CONTRIB_VERSION}_linux_${OTEL_ARCH}.tar.gz" \
      -o /tmp/otelcol-contrib.tar.gz && \
    tar -xzf /tmp/otelcol-contrib.tar.gz -C /tmp otelcol-contrib && \
    install -m 0755 /tmp/otelcol-contrib /usr/local/bin/otelcol-contrib && \
    rm -f /tmp/otelcol-contrib.tar.gz /tmp/otelcol-contrib

# Create runtime users and writable dirs up front so entrypoint stays simple.
# `iterate-caddy` exists at build time for iptables owner-based bypass rules.
RUN groupadd -g 1001 iterate && \
    useradd -m -u 1001 -g iterate -s /bin/bash iterate && \
    useradd -m -u 1002 -g iterate -s /bin/bash iterate-caddy && \
    useradd -M -u 1003 -g iterate -s /usr/sbin/nologin iterate-egress && \
    echo 'iterate ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/iterate && \
    chmod 0440 /etc/sudoers.d/iterate && \
    mkdir -p \
      "$ITERATE_REPO" \
      /var/lib/jonasland \
      /var/lib/openobserve \
      /var/log/pidnap && \
    chown -R iterate:iterate /home/iterate /var/lib/jonasland /var/lib/openobserve /var/log/pidnap && \
    chown -R iterate-caddy:iterate /home/iterate-caddy

# Install user-scoped CLIs as the `iterate` user so file ownership is correct.
USER iterate

# PATH setup for iterate tools. These ENV statements set PATH for non-shell contexts
# (e.g. `docker exec container opencode`). Login shells reset PATH via /etc/profile,
# so home-skeleton/.profile must ALSO set up these paths for `bash -l` and SSH to work.
ENV PATH="/home/iterate/.iterate/bin:/home/iterate/.local/bin:$PATH"

# Configure npm for userspace global installs
RUN mkdir -p ~/.npm-global && \
    npm config set prefix ~/.npm-global
ENV PATH="/home/iterate/.npm-global/bin:$PATH"

# Install bun
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${SANDBOX_BUN_VERSION}"
ENV PATH="/home/iterate/.bun/bin:$PATH"

# Install Go
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then GO_ARCH="arm64"; else GO_ARCH="amd64"; fi && \
    curl -fsSL "https://go.dev/dl/go${SANDBOX_GO_VERSION}.linux-${GO_ARCH}.tar.gz" | sudo tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:/home/iterate/go/bin:$PATH"
ENV GOPATH="/home/iterate/go"

# Install flyctl (Fly.io CLI)
RUN curl -fsSL https://fly.io/install.sh | sh
ENV PATH="/home/iterate/.fly/bin:$PATH"

# Install gogcli (Google Suite CLI: Gmail, GCal, GDrive, etc.)
RUN mkdir -p /home/iterate/.local/bin && \
    git clone https://github.com/mmkal/gogcli.git /tmp/gogcli && \
    cd /tmp/gogcli && \
    git checkout ${SANDBOX_GOGCLI_REF} && \
    go build -o /home/iterate/.local/bin/gog ./cmd/gog && \
    rm -rf /tmp/gogcli

# Agent packages (npm, userspace)
RUN npm install -g \
    @mariozechner/pi-coding-agent@${PI_CODING_AGENT_VERSION} \
    @openai/codex@${SANDBOX_CODEX_VERSION} \
    && npm cache clean --force
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- ${SANDBOX_CLAUDE_CODE_VERSION}
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version ${SANDBOX_OPENCODE_VERSION}
ENV PATH="/home/iterate/.opencode/bin:$PATH"

# Ensure wrapper scripts win after all PATH modifications.
ENV PATH="/home/iterate/.iterate/bin:/home/iterate/.local/bin:$PATH"

# Warm OpenCode plugin deps by downloading from npm; speeds first session.
RUN set -e && \
    opencode --version && \
    set +e && \
    echo "--- opencode warm-up (errors below are expected) ---" && \
    opencode run "Hello" 2>&1; \
    warmup_exit=$?; \
    echo "--- opencode warm-up finished (exit=$warmup_exit) ---"

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

USER iterate-caddy
ENV HOME=/home/iterate-caddy
ENV XDG_DATA_HOME=/home/iterate-caddy/.local/share
ENV XDG_CONFIG_HOME=/home/iterate-caddy/.config
RUN printf ':8443 {\n  tls internal\n  respond "ok" 200\n}\n' > /tmp/caddy-pki.caddyfile && \
    caddy start --config /tmp/caddy-pki.caddyfile --adapter caddyfile && \
    sleep 2 && \
    caddy stop && \
    rm /tmp/caddy-pki.caddyfile && \
    test -f /home/iterate-caddy/.local/share/caddy/pki/authorities/local/root.crt
# Runtimes with compiled-in cert bundles that ignore the system store:
#   - Node.js: NODE_USE_SYSTEM_CA=1 (v22.5+) makes Node read the system store
#     directly, so we do not need to point it at iterate-caddy's private home.
#   - Python requests: uses certifi (Mozilla bundle) by default; override with
#     REQUESTS_CA_BUNDLE pointing at the system bundle which includes caddy's CA.
# Go, Rust (rustls-native-certs), curl, git all read the system store natively.
USER root
RUN mkdir -p /usr/local/share/ca-certificates/iterate && \
    cp /home/iterate-caddy/.local/share/caddy/pki/authorities/local/root.crt /usr/local/share/ca-certificates/iterate/caddy-local-root.crt && \
    update-ca-certificates
USER iterate
ENV HOME=/home/iterate
ENV XDG_DATA_HOME=/home/iterate/.local/share
ENV XDG_CONFIG_HOME=/home/iterate/.config
ENV NODE_USE_SYSTEM_CA=1 \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

# Set workspace root for dependency install and later runtime commands.
# pnpm reads npm-style config env vars, so `npm_config_store_dir` is the
# runtime-safe way to point both build-time pnpm and host-sync pnpm installs at
# the shared Docker volume without affecting earlier `npm install -g` steps.
ENV npm_config_store_dir=/home/iterate/.pnpm-store
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
