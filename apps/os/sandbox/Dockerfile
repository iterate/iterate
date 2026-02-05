# syntax=docker/dockerfile:1
FROM node:24

# === Versions ===
ARG SANDBOX_CODEX_VERSION=0.93.0
ARG SANDBOX_OPENCODE_VERSION=1.1.41
ARG SANDBOX_CLAUDE_CODE_VERSION=2.1.12
ARG SANDBOX_PI_CODING_AGENT_VERSION=0.49.2
ARG SANDBOX_BUN_VERSION=1.3.6
ARG SANDBOX_GO_VERSION=1.23.4
ARG SANDBOX_GOGCLI_REF=99d957581f61532de08f3847e79f639edad3c68b

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
      locales \
      make \
      openssh-client \
      rsync \
      sqlite3 \
      sudo \
      tini \
      tmux \
      unzip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s $(which fdfind) /usr/local/bin/fd

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

# Git config for iterate user
RUN git config --global user.name "iterate" && \
    git config --global user.email "233973017+iterate[bot]@users.noreply.github.com"

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
COPY --chown=iterate:iterate --exclude=.git --exclude=.git/ . .
RUN if [ -f .git ]; then rm .git && mkdir .git; fi

# Ensure shell scripts are executable (git may not preserve permissions on all platforms)
RUN chmod +x apps/os/sandbox/*.sh

# Install dependencies (cacheable - only reruns when lockfile changes)
RUN pnpm install --frozen-lockfile --offline

# Build daemon frontend (cacheable - only reruns when source changes)
RUN (cd "$ITERATE_REPO/apps/daemon" && pnpm vite build)

# Run database migrations
RUN (cd "$ITERATE_REPO/apps/daemon" && pnpm db:migrate)

# Generate mitmproxy CA certificate at build time.
# This certificate is safe to share across all sandbox instances because:
# 1. Each sandbox is network-isolated - they cannot communicate with each other
# 2. The cert is only used for the local egress proxy within each sandbox
# 3. No sandbox can intercept another sandbox's traffic
RUN mkdir -p /home/iterate/.mitmproxy && \
    /home/iterate/.local/bin/mitmdump -p 0 --set confdir=/home/iterate/.mitmproxy &>/dev/null & \
    PID=$! && \
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

# Copy home skeleton into /home/iterate
RUN bash "$ITERATE_REPO/apps/os/sandbox/sync-home-skeleton.sh"
# Warm OpenCode plugin deps (esp auth) by downloading from npm; speeds first session
RUN opencode run "Hello" || true

# === Git directory and metadata (MUST be last - changes every commit) ===
# Copy a minimal .git directory with packed objects for HEAD.
# This allows `git status` to work in the container, showing dirty files.
# The pack file is deterministic for the same commit SHA, ensuring cache hits.
# NOTE: This is placed AFTER heavy build steps so cache isn't busted by merge commits.
COPY --from=iterate-synthetic-git --chown=iterate:iterate . $ITERATE_REPO/.git

# Rebuild the git index so `git status` works correctly
RUN git reset HEAD

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA

ENTRYPOINT ["/home/iterate/src/github.com/iterate/iterate/apps/os/sandbox/entry.sh"]
