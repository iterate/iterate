FROM node:24 AS base

# Build cache buster: 2026-01-20T13:16
# (change this comment to force Daytona to rebuild when cache is stale)

# === Version Configuration ===
# Edit these to update versions (requires image rebuild)
# Exposed as ENV vars for visibility inside container
ENV SANDBOX_OPENCODE_VERSION=1.1.27
ENV SANDBOX_CLAUDE_CODE_VERSION=2.1.12
ENV SANDBOX_PI_CODING_AGENT_VERSION=0.49.2
ENV SANDBOX_BUN_VERSION=1.3.6

# === Build Args ===
# SANDBOX_ITERATE_REPO_REF: git ref (branch/SHA) to clone. If empty, creates placeholder for local mount.
ARG SANDBOX_ITERATE_REPO_REF=""
# ITERATE_MACHINE_PROVIDER: baked into image for bootstrap decisions (e.g., local-docker, daytona)
ARG ITERATE_MACHINE_PROVIDER="unknown"

# === System packages (as root) ===

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y btop fd-find gh rsync sqlite3 sudo tmux && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    ln -s $(which fdfind) /usr/local/bin/fd

# Create non-root user with passwordless sudo
RUN useradd -m -s /bin/bash iterate && \
    echo 'iterate ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers.d/iterate && \
    chmod 0440 /etc/sudoers.d/iterate

# Global npm tools (as root for system-wide access)
RUN npm install -g pnpm pm2 tsx
ENV NODE_PATH=/usr/local/lib/node_modules

# Iterate CLI wrapper (uses ~ which resolves to user's home at runtime)
RUN echo '#!/bin/sh' > /usr/local/bin/iterate && \
    echo 'exec tsx --env-file-if-exists ~/.iterate/.env ~/src/github.com/iterate/iterate/apps/cli/main.ts "$@"' >> /usr/local/bin/iterate && \
    chmod +x /usr/local/bin/iterate

# === Switch to non-root user ===

USER iterate
WORKDIR /home/iterate

# Git config for iterate user
RUN git config --global user.name "iterate" && \
    git config --global user.email "233973017+iterate[bot]@users.noreply.github.com"

# Configure npm for userspace global installs
RUN mkdir -p ~/.npm-global && \
    npm config set prefix ~/.npm-global
ENV PATH="/home/iterate/.npm-global/bin:$PATH"

# Install bun (installs to ~/.bun)
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${SANDBOX_BUN_VERSION}"
ENV PATH="/home/iterate/.bun/bin:$PATH"

# === Agent packages (npm, userspace) ===

RUN npm install -g @anthropic-ai/claude-code@${SANDBOX_CLAUDE_CODE_VERSION} && \
    npm install -g @mariozechner/pi-coding-agent@${SANDBOX_PI_CODING_AGENT_VERSION} && \
    npm install -g --libc=glibc opencode-ai@${SANDBOX_OPENCODE_VERSION}

# Wrap claude to always use --dangerously-skip-permissions (safe in sandbox)
# Note: npm creates a symlink, must rm first or echo writes through to cli.js
RUN mkdir -p /home/iterate/.local/bin && \
    CLAUDE_BIN=/home/iterate/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js && \
    rm -f /home/iterate/.npm-global/bin/claude && \
    echo '#!/bin/sh' > /home/iterate/.local/bin/claude && \
    echo "exec node $CLAUDE_BIN --dangerously-skip-permissions \"\$@\"" >> /home/iterate/.local/bin/claude && \
    chmod +x /home/iterate/.local/bin/claude
ENV PATH="/home/iterate/.local/bin:$PATH"

FROM scratch AS local-context
COPY . /local-context

FROM base AS sandbox-local

ARG ITERATE_MACHINE_PROVIDER

ENV ITERATE_REPO=/home/iterate/src/github.com/iterate/iterate
ENV ITERATE_MACHINE_PROVIDER=$ITERATE_MACHINE_PROVIDER

# Seed the repo with the build context for local-docker images.
RUN mkdir -p $ITERATE_REPO
COPY --from=local-context --chown=iterate:iterate /local-context /tmp/iterate-local
RUN rsync -a --delete --filter=':- .gitignore' /tmp/iterate-local/ $ITERATE_REPO/ && \
    rm -rf /tmp/iterate-local

RUN mkdir -p /home/iterate/.local/bin && \
    cp $ITERATE_REPO/apps/os/sandbox/daemon-bootstrap.sh /home/iterate/.local/bin/iterate-daemon-bootstrap.sh && \
    cp $ITERATE_REPO/apps/os/sandbox/local-docker-sync.sh /home/iterate/.local/bin/local-docker-sync.sh && \
    cp $ITERATE_REPO/apps/os/sandbox/env-refresh-cron.sh /home/iterate/.local/bin/env-refresh-cron.sh && \
    chmod +x /home/iterate/.local/bin/iterate-daemon-bootstrap.sh /home/iterate/.local/bin/local-docker-sync.sh /home/iterate/.local/bin/env-refresh-cron.sh

RUN chmod +x $ITERATE_REPO/apps/os/sandbox/*.sh || true

# Create .iterate dir with placeholder .env (daemon injects real env vars at runtime)
RUN mkdir -p ~/.iterate && \
    echo "# if you can see this, the daemon hasn't been able to inject env vars yet" > ~/.iterate/.env

CMD [ "pm2-runtime", "start", "/home/iterate/src/github.com/iterate/iterate/apps/os/sandbox/ecosystem.config.cjs" ]

FROM base AS sandbox-remote

# Re-declare ARG after USER switch (ARGs don't persist across USER)
ARG SANDBOX_ITERATE_REPO_REF
ARG ITERATE_MACHINE_PROVIDER

ENV ITERATE_REPO=/home/iterate/src/github.com/iterate/iterate
ENV ITERATE_MACHINE_PROVIDER=$ITERATE_MACHINE_PROVIDER

# If ref provided, clone from git; otherwise create placeholder for local mount
RUN if [ -n "$SANDBOX_ITERATE_REPO_REF" ]; then \
      git clone https://github.com/iterate/iterate.git $ITERATE_REPO && \
      cd $ITERATE_REPO && git checkout $SANDBOX_ITERATE_REPO_REF; \
    else \
      mkdir -p $ITERATE_REPO/apps/os/sandbox; \
    fi

# Ensure PM2 configs and scripts exist even when repo isn't cloned yet
COPY --chown=iterate:iterate apps/os/sandbox/ /tmp/sandbox/
RUN mkdir -p /home/iterate/.local/bin && \
    cp /tmp/sandbox/ecosystem.config.cjs $ITERATE_REPO/apps/os/sandbox/ecosystem.config.cjs && \
    cp /tmp/sandbox/daemon-bootstrap.sh /home/iterate/.local/bin/iterate-daemon-bootstrap.sh && \
    cp /tmp/sandbox/local-docker-sync.sh /home/iterate/.local/bin/local-docker-sync.sh && \
    cp /tmp/sandbox/env-refresh-cron.sh /home/iterate/.local/bin/env-refresh-cron.sh && \
    chmod +x /home/iterate/.local/bin/iterate-daemon-bootstrap.sh /home/iterate/.local/bin/local-docker-sync.sh /home/iterate/.local/bin/env-refresh-cron.sh && \
    chmod +x $ITERATE_REPO/apps/os/sandbox/*.sh || true && \
    rm -rf /tmp/sandbox

# Install deps and build daemon (only if repo was cloned)
RUN if [ -n "$SANDBOX_ITERATE_REPO_REF" ]; then \
      cd $ITERATE_REPO && pnpm install; \
    fi

RUN if [ -n "$SANDBOX_ITERATE_REPO_REF" ]; then \
      cd $ITERATE_REPO/apps/daemon && npx vite build; \
    fi

# Create .iterate dir with placeholder .env (daemon injects real env vars at runtime)
RUN mkdir -p ~/.iterate && \
    echo "# if you can see this, the daemon hasn't been able to inject env vars yet" > ~/.iterate/.env

# Setup home directory (only if repo was cloned; bootstrap handles local mode)
RUN if [ -n "$SANDBOX_ITERATE_REPO_REF" ]; then \
      $ITERATE_REPO/apps/os/sandbox/setup-home.sh; \
    fi

CMD [ "pm2-runtime", "start", "/home/iterate/src/github.com/iterate/iterate/apps/os/sandbox/ecosystem.config.cjs" ]
