# syntax=docker/dockerfile:1
FROM node:24

# === Versions ===
ARG SANDBOX_CODEX_VERSION=0.98.0
ARG SANDBOX_OPENCODE_VERSION=1.2.4
ARG SANDBOX_CLAUDE_CODE_VERSION=2.1.37
ARG SANDBOX_PI_CODING_AGENT_VERSION=0.52.8
ARG SANDBOX_BUN_VERSION=1.3.6
ARG SANDBOX_GO_VERSION=1.23.4
ARG SANDBOX_GOGCLI_REF=99d957581f61532de08f3847e79f639edad3c68b
ARG SANDBOX_JAEGER_VERSION=1.67.0

# Install curl first (may not be present in all base images)
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y --no-install-recommends \
    bash \
    btop \
    build-essential \
    ca-certificates \
    fd-find \
    gh \
    git \
    inotify-tools \
    jq \
    less \
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

# Create non-root user with passwordless sudo
RUN useradd -m -s /bin/bash iterate && \
    echo 'iterate ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers.d/iterate && \
    chmod 0440 /etc/sudoers.d/iterate && \
    mkdir -p /home/iterate/src/github.com/iterate \
    /var/log/pidnap && \
    chown -R iterate:iterate /home/iterate /var/log/pidnap

USER iterate

# PATH setup for iterate tools. These ENV statements set PATH for non-shell contexts
# (e.g. `docker exec container opencode`). Login shells reset PATH via /etc/profile,
# so home-skeleton/.profile must ALSO set up these paths for `bash -l` and SSH to work.
# Keep both in sync! The .iterate/bin paths must be prepended last so wrappers win.
ENV PATH="/home/iterate/.iterate/bin:/home/iterate/.local/bin:$PATH"

# Install uv and use that to install mitmproxy
RUN curl -fsSL https://astral.sh/uv/install.sh | sh
RUN uv tool install mitmproxy

# Configure npm for userspace global installs
RUN mkdir -p ~/.npm-global && \
    npm config set prefix ~/.npm-global
ENV PATH="/home/iterate/.npm-global/bin:$PATH"

# Install bun (installs to ~/.bun)
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${SANDBOX_BUN_VERSION}"
ENV PATH="/home/iterate/.bun/bin:$PATH"

# Install Go (detect architecture at build time)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then GO_ARCH="arm64"; else GO_ARCH="amd64"; fi && \
    curl -fsSL "https://go.dev/dl/go${SANDBOX_GO_VERSION}.linux-${GO_ARCH}.tar.gz" | sudo tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:/home/iterate/go/bin:$PATH"
ENV GOPATH="/home/iterate/go"

# Install gogcli (Google Suite CLI: Gmail, GCal, GDrive, etc.)
# Uses mmkal's fork with --access-token support for headless/proxy environments
RUN mkdir -p /home/iterate/.local/bin && \
    git clone https://github.com/mmkal/gogcli.git /tmp/gogcli && \
    cd /tmp/gogcli && \
    git checkout ${SANDBOX_GOGCLI_REF} && \
    go build -o /home/iterate/.local/bin/gog ./cmd/gog && \
    rm -rf /tmp/gogcli

# === Agent packages (npm, userspace) ===
RUN npm install -g @mariozechner/pi-coding-agent@${SANDBOX_PI_CODING_AGENT_VERSION}
RUN npm install -g @openai/codex@${SANDBOX_CODEX_VERSION}
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- ${SANDBOX_CLAUDE_CODE_VERSION}
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version ${SANDBOX_OPENCODE_VERSION}
ENV PATH="/home/iterate/.opencode/bin:$PATH"
# Ensure wrapper scripts win after all PATH modifications.
ENV PATH="/home/iterate/.iterate/bin:/home/iterate/.local/bin:$PATH"

# Repo path and working dir (used by COPY steps below).
ENV ITERATE_REPO=/home/iterate/src/github.com/iterate/iterate
WORKDIR /home/iterate/src/github.com/iterate/iterate

# Copy lockfile first (dependency layer)
# This way, unless the dependencies change, we don't have to download from pnpm
# TODO: consider BuildKit cache mount for pnpm store to speed CI builds.
COPY --chown=iterate:iterate package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then PNPM_ARCH="x64"; else PNPM_ARCH="arm64"; fi && \
    pnpm fetch --config.platform=linux --config.arch="$PNPM_ARCH" --config.libc=glibc

# Copy repo, exclude git metadata from context.
# If .git is a worktree file, replace with dir
COPY --chown=iterate:iterate --exclude=.git --exclude=.git/ --exclude=node_modules . .
RUN if [ -f .git ]; then rm .git && mkdir .git; fi

# Ensure shell scripts are executable (git may not preserve permissions on all platforms)
RUN chmod +x sandbox/*.sh sandbox/providers/docker/*.sh

# Install dependencies (cacheable - only reruns when lockfile changes)
RUN pnpm install --frozen-lockfile --offline

# Run post-repo-sync steps (cacheable - only reruns when source changes)
RUN bash "$ITERATE_REPO/sandbox/after-repo-sync-steps.sh"

# Generate mitmproxy CA certificate at build time.
# This certificate is safe to share across all sandbox instances because:
# 1. Each sandbox is network-isolated - they cannot communicate with each other
# 2. The cert is only used for the local egress proxy within each sandbox
# 3. No sandbox can intercept another sandbox's traffic
RUN mkdir -p /home/iterate/.mitmproxy && \
    /home/iterate/.local/bin/mitmdump -p 0 --set confdir=/home/iterate/.mitmproxy &>/dev/null & \
    PID=$! && \
    # TODO: replace this polling hack with a direct cert-generation command.
    # Track in tasks/mitmproxy-direct-cert-command.md.
    # Cert generation is not immediate; poll for CA file before continuing.
    for i in $(seq 1 30); do \
    [ -f /home/iterate/.mitmproxy/mitmproxy-ca-cert.pem ] && break; \
    sleep 0.5; \
    done && \
    kill $PID 2>/dev/null || true && \
    test -f /home/iterate/.mitmproxy/mitmproxy-ca-cert.pem

# Install mitmproxy CA certificate system-wide
RUN sudo mkdir -p /usr/local/share/ca-certificates/iterate && \
    sudo cp /home/iterate/.mitmproxy/mitmproxy-ca-cert.pem /usr/local/share/ca-certificates/iterate/mitmproxy-ca.crt && \
    sudo update-ca-certificates

# Warm OpenCode plugin deps (esp auth) by downloading from npm; speeds first session.
# Use a free model — no API keys are available at build time.
RUN opencode run --model opencode/kimi-k2.5-free "Hello" || true

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
