FROM node:24

# === Versions ===
ARG SANDBOX_CODEX_VERSION=0.93.0
ARG SANDBOX_OPENCODE_VERSION=1.1.41
ARG SANDBOX_CLAUDE_CODE_VERSION=2.1.12
ARG SANDBOX_PI_CODING_AGENT_VERSION=0.49.2
ARG SANDBOX_BUN_VERSION=1.3.6
ARG SANDBOX_GO_VERSION=1.23.4
ARG SANDBOX_GOGCLI_REF=99d957581f61532de08f3847e79f639edad3c68b

ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.revision=$GIT_SHA

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

# Create non-root user with passwordless sudo
RUN useradd -m -s /bin/bash iterate && \
    echo 'iterate ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers.d/iterate && \
    chmod 0440 /etc/sudoers.d/iterate && \
    mkdir -p /home/iterate/src/github.com/iterate \
    /var/log/pidnap && \
    chown -R iterate:iterate /home/iterate /var/log/pidnap

# Iterate CLI wrapper (uses ~ which resolves to user's home at runtime)
RUN echo '#!/bin/sh' > /usr/local/bin/iterate && \
    echo 'exec tsx --env-file-if-exists ~/.iterate/.env ~/src/github.com/iterate/iterate/apps/cli/main.ts "$@"' >> /usr/local/bin/iterate && \
    chmod +x /usr/local/bin/iterate

# Replicate CLI shim - directs users to iterate tool replicate
RUN echo '#!/bin/sh' > /usr/local/bin/replicate && \
    echo 'echo "Error: The replicate CLI is not installed." >&2' >> /usr/local/bin/replicate && \
    echo 'echo "Use iterate tool replicate instead. Example:" >&2' >> /usr/local/bin/replicate && \
    echo 'echo "" >&2' >> /usr/local/bin/replicate && \
    echo 'echo "  iterate tool replicate '"'"'const output = await replicate.run(\"black-forest-labs/flux-schnell\", { input: { prompt: \"a cat\" } }); console.log(output);'"'"'" >&2' >> /usr/local/bin/replicate && \
    echo 'echo "" >&2' >> /usr/local/bin/replicate && \
    echo 'exit 1' >> /usr/local/bin/replicate && \
    chmod +x /usr/local/bin/replicate

USER iterate

# Primary reason for this Dockerfile: keep wrapper scripts at absolute PATH top
# (e.g. wrap claude/codex with dangerously skipped permissions).
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

# Copy repo (exclude .git file from worktrees)
COPY --chown=iterate:iterate --exclude=.git . .

# Ensure shell scripts are executable (git may not preserve permissions on all platforms)
RUN chmod +x apps/os/sandbox/*.sh

# Overlay git directory pieces from BuildKit contexts (worktree-safe).
# In a worktree, .git is a file that points at the real gitdir/commondir on disk.
# The build script passes both as BuildKit contexts, then we copy them into
# $ITERATE_REPO/.git and remove the indirection markers so git works in-container.
COPY --from=iterate-repo-commondir --chown=iterate:iterate . $ITERATE_REPO/.git
COPY --from=iterate-repo-gitdir --chown=iterate:iterate . $ITERATE_REPO/.git
RUN rm -f $ITERATE_REPO/.git/commondir $ITERATE_REPO/.git/gitdir

# Install dependencies
RUN pnpm install --frozen-lockfile --offline

# Build daemon frontend
RUN (cd "$ITERATE_REPO/apps/daemon" && pnpm vite build)

# Copy home skeleton into /home/iterate
RUN bash "$ITERATE_REPO/apps/os/sandbox/sync-home-skeleton.sh"

ENTRYPOINT ["/home/iterate/src/github.com/iterate/iterate/apps/os/sandbox/entry.sh"]
