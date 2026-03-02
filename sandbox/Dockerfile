# syntax=docker/dockerfile:1
FROM node:24

# === Versions ===
ARG SANDBOX_AGENT_BROWSER_VERSION=0.13.0
ARG SANDBOX_CODEX_VERSION=0.98.0
ARG SANDBOX_OPENCODE_VERSION=1.2.15
ARG SANDBOX_CLAUDE_CODE_VERSION=2.1.50
ARG SANDBOX_PI_CODING_AGENT_VERSION=0.52.8
ARG SANDBOX_MITMPROXY_VERSION=11.1.3
ARG SANDBOX_BUN_VERSION=1.3.6
ARG SANDBOX_GO_VERSION=1.23.4
ARG SANDBOX_GOGCLI_REF=99d957581f61532de08f3847e79f639edad3c68b
ARG SANDBOX_JAEGER_VERSION=1.67.0

# Install curl first (may not be present in all base images)
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

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
    doppler \
    fd-find \
    gh \
    git \
    inotify-tools \
    jq \
    less \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libfuse2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxfixes3 \
    libxi6 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    locales \
    make \
    openssh-client \
    ripgrep \
    rsync \
    sqlite3 \
    sudo \
    tini \
    tmux \
    unzip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s $(which fdfind) /usr/local/bin/fd

# Install cloudflared (Cloudflare Tunnel client) — used to expose local ports via trycloudflare.com
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb" && \
    dpkg -i /tmp/cloudflared.deb && \
    rm /tmp/cloudflared.deb

# Install Jaeger all-in-one (trace viewer + OTLP collector)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then JAEGER_ARCH="arm64"; else JAEGER_ARCH="amd64"; fi && \
    curl -fsSL "https://github.com/jaegertracing/jaeger/releases/download/v${SANDBOX_JAEGER_VERSION}/jaeger-${SANDBOX_JAEGER_VERSION}-linux-${JAEGER_ARCH}.tar.gz" -o /tmp/jaeger.tgz && \
    tar -xzf /tmp/jaeger.tgz -C /tmp && \
    install -m 0755 "/tmp/jaeger-${SANDBOX_JAEGER_VERSION}-linux-${JAEGER_ARCH}/jaeger-all-in-one" /usr/local/bin/jaeger-all-in-one && \
    rm -rf "/tmp/jaeger-${SANDBOX_JAEGER_VERSION}-linux-${JAEGER_ARCH}" /tmp/jaeger.tgz

RUN corepack enable

# Global npm tools (as root for system-wide access)
RUN corepack prepare pnpm@10.24.0 --activate && \
    npm install -g tsx serve

# Configure UTF-8 locale (required for btop and other CLI tools)
RUN localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# === Install tools to system paths (survive archil bind-mount over ~) ===
# All tools below install to /opt/ or /usr/local/ so they're available even
# after archil mounts a persistent disk over /home/iterate.

# Install uv to /opt/uv (as root)
RUN curl -fsSL https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/opt/uv/bin sh
ENV PATH="/opt/uv/bin:$PATH"

# Install mitmproxy via uv to /opt/mitmproxy.
# UV_PYTHON_INSTALL_DIR puts the managed Python in a system path (not /root/.local/share/uv/python)
# so the iterate user can execute mitmproxy scripts via their shebang lines.
RUN UV_TOOL_DIR=/opt/mitmproxy/tools UV_TOOL_BIN_DIR=/opt/mitmproxy/bin \
    UV_PYTHON_INSTALL_DIR=/opt/uv/python \
    /opt/uv/bin/uv tool install --python 3.12 mitmproxy==${SANDBOX_MITMPROXY_VERSION} && \
    chmod -R a+rX /opt/uv /opt/mitmproxy
ENV PATH="/opt/mitmproxy/bin:$PATH"

# Generate mitmproxy CA certificate at build time to /opt/mitmproxy/certs.
# This certificate is baked into the image and shared across all sandbox instances.
# This is safe because:
# 1. Each sandbox is network-isolated - they cannot communicate with each other
# 2. The cert is only used for the local egress proxy within each sandbox
# 3. No sandbox can intercept another sandbox's traffic
# Note: The CA keypair is regenerated when SANDBOX_MITMPROXY_VERSION changes (layer invalidation).
RUN mkdir -p /opt/mitmproxy/certs && \
    /opt/mitmproxy/bin/mitmdump -p 0 --set confdir=/opt/mitmproxy/certs &>/dev/null & \
    PID=$! && \
    # TODO: replace this polling hack with a direct cert-generation command.
    # Track in tasks/mitmproxy-direct-cert-command.md.
    # Cert generation is not immediate; poll for CA file before continuing.
    for i in $(seq 1 30); do \
      [ -f /opt/mitmproxy/certs/mitmproxy-ca-cert.pem ] && break; \
      sleep 0.5; \
    done && \
    kill $PID 2>/dev/null || true && \
    test -f /opt/mitmproxy/certs/mitmproxy-ca-cert.pem && \
    chmod -R a+rX /opt/mitmproxy/certs

# Install mitmproxy CA certificate system-wide
RUN mkdir -p /usr/local/share/ca-certificates/iterate && \
    cp /opt/mitmproxy/certs/mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/iterate/mitmproxy-ca.crt && \
    update-ca-certificates

# Install npm global packages (agent-browser, codex, pi) to /opt/npm-global
RUN mkdir -p /opt/npm-global && \
    npm config set prefix /opt/npm-global && \
    npm install -g \
    agent-browser@${SANDBOX_AGENT_BROWSER_VERSION} \
    @mariozechner/pi-coding-agent@${SANDBOX_PI_CODING_AGENT_VERSION} \
    @openai/codex@${SANDBOX_CODEX_VERSION} \
    && npm cache clean --force
ENV PATH="/opt/npm-global/bin:$PATH"

# Install bun to /opt/bun
RUN BUN_INSTALL=/opt/bun curl -fsSL https://bun.sh/install | bash -s "bun-v${SANDBOX_BUN_VERSION}"
ENV PATH="/opt/bun/bin:$PATH"

# Install Go (detect architecture at build time) — already goes to /usr/local/go
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then GO_ARCH="arm64"; else GO_ARCH="amd64"; fi && \
    curl -fsSL "https://go.dev/dl/go${SANDBOX_GO_VERSION}.linux-${GO_ARCH}.tar.gz" | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:/opt/go/bin:$PATH"
ENV GOPATH="/opt/go"

# Install flyctl to /opt/fly
RUN FLYCTL_INSTALL=/opt/fly curl -fsSL https://fly.io/install.sh | sh
ENV PATH="/opt/fly/bin:$PATH"

# Install gogcli (Google Suite CLI: Gmail, GCal, GDrive, etc.)
# Uses mmkal's fork with --access-token support for headless/proxy environments
RUN git clone https://github.com/mmkal/gogcli.git /tmp/gogcli && \
    cd /tmp/gogcli && \
    git checkout ${SANDBOX_GOGCLI_REF} && \
    GOPATH=/opt/go go build -o /usr/local/bin/gog ./cmd/gog && \
    rm -rf /tmp/gogcli

# Install Archil client (persistent POSIX volumes backed by S3/R2)
# Installs to /usr/bin/archil by default (system path, survives bind-mount)
RUN curl -s https://s3.amazonaws.com/archil-client/install | sh || true

# Install Claude Code to /opt/claude.
# The installer runs `claude install` which places the launcher at ~/.local/bin/claude.
# Set HOME=/opt/claude so it installs there instead of the real home dir.
RUN mkdir -p /opt/claude && HOME=/opt/claude bash -c "curl -fsSL https://claude.ai/install.sh | bash -s -- ${SANDBOX_CLAUDE_CODE_VERSION}"
ENV PATH="/opt/claude/.local/bin:$PATH"

# Install OpenCode to /opt/opencode.
# The installer places the binary at ~/.opencode/bin/opencode.
# Set HOME=/opt/opencode so it installs there.
RUN mkdir -p /opt/opencode && HOME=/opt/opencode bash -c "curl -fsSL https://opencode.ai/install | bash -s -- --version ${SANDBOX_OPENCODE_VERSION}"
ENV PATH="/opt/opencode/.opencode/bin:$PATH"

# agent-browser chromium is installed on first boot via archil-mount.sh (persists on archil disk).
# This saves ~700MB from the Docker image.

# Create non-root user with passwordless sudo
RUN useradd -m -s /bin/bash iterate && \
    echo 'iterate ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers.d/iterate && \
    chmod 0440 /etc/sudoers.d/iterate && \
    mkdir -p /home/iterate/src/github.com/iterate \
    /var/log/pidnap && \
    chown -R iterate:iterate /home/iterate /var/log/pidnap && \
    chown -R iterate:iterate /opt/npm-global /opt/go /opt/opencode /opt/claude

USER iterate

# PATH setup for iterate tools. These ENV statements set PATH for non-shell contexts
# (e.g. `docker exec container opencode`). Login shells reset PATH via /etc/profile,
# so home-skeleton/.profile must ALSO set up these paths for `bash -l` and SSH to work.
# Keep both in sync! The .iterate/bin paths must be prepended last so wrappers win.
ENV PATH="/home/iterate/.iterate/bin:/opt/claude/.local/bin:/opt/opencode/.opencode/bin:/opt/mitmproxy/bin:/opt/uv/bin:/opt/npm-global/bin:/opt/bun/bin:/opt/fly/bin:/usr/local/go/bin:/opt/go/bin:$PATH"

# Warm OpenCode plugin deps (esp auth) by downloading from npm; speeds first session.
# No API keys exist at build time, so the LLM call itself will fail — that's expected.
# We only care that opencode boots far enough to download its npm deps.
# Errors we accept: model not found, auth failures, network issues.
# Errors we do NOT accept: opencode binary missing or broken (checked by --version).
RUN set -e && \
    opencode --version && \
    set +e && \
    echo "--- opencode warm-up (errors below are expected) ---" && \
    opencode run "Hello" 2>&1; \
    warmup_exit=$?; \
    echo "--- opencode warm-up finished (exit=$warmup_exit) ---" && \
    rm -rf /home/iterate/.cache

# Repo path and working dir (used by COPY steps below).
ENV ITERATE_REPO=/home/iterate/src/github.com/iterate/iterate
WORKDIR /home/iterate/src/github.com/iterate/iterate

# Copy repo (exclude git metadata and node_modules from context).
# If .git is a worktree file, replace with dir
COPY --chown=iterate:iterate --exclude=.git --exclude=.git/ --exclude=node_modules . .
RUN if [ -f .git ]; then rm .git && mkdir .git; fi

# Ensure shell scripts are executable (git may not preserve permissions on all platforms)
RUN chmod +x sandbox/*.sh sandbox/providers/docker/*.sh

# Copy egress proxy addon to a system path so it's available before archil-mount
# clones the repo (the archil bind-mount hides ~/src/... during first boot).
RUN sudo cp sandbox/egress-proxy-addon.py /opt/mitmproxy/egress-proxy-addon.py

# Install dependencies then clean the pnpm content-addressable store.
# The store is only needed during install — node_modules/.pnpm has hardlinks
# that survive store deletion. This saves ~1.7GB from the image.
# On machines with archil, deps are cached on the persistent disk across boots.
RUN pnpm install --frozen-lockfile && \
    rm -rf /home/iterate/.local/share/pnpm/store

# Run post-repo-sync steps (cacheable - only reruns when source changes)
RUN bash "$ITERATE_REPO/sandbox/after-repo-sync-steps.sh"

ARG GIT_SHA=unknown
# Keep a functional git repo inside the image for tools/tests that call git.
RUN git init && \
    git config user.email "iterate-bot@noreply.iterate.com" && \
    git config user.name "iterate-bot" && \
    git add . && \
    git commit -m "snapshot ${GIT_SHA}" && \
    git branch -M main

ENV GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA

ENTRYPOINT ["/home/iterate/src/github.com/iterate/iterate/sandbox/entry.sh"]
