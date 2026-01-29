FROM node:24

# Build cache buster: 2026-01-26T11:00
# (change this comment to force Daytona to rebuild when cache is stale)

# === Version Configuration ===
# Edit these to update versions (requires image rebuild)
# Exposed as ENV vars for visibility inside container
ENV SANDBOX_OPENCODE_VERSION=1.1.27
ENV SANDBOX_CLAUDE_CODE_VERSION=2.1.12
ENV SANDBOX_PI_CODING_AGENT_VERSION=0.49.2
ENV SANDBOX_BUN_VERSION=1.3.6

# === System packages (as root) ===

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y btop build-essential fd-find gh git inotify-tools make python3-pip rsync s6 sqlite3 sudo tini tmux && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    ln -s $(which fdfind) /usr/local/bin/fd

# Install mitmproxy for egress proxy
RUN pip3 install --break-system-packages mitmproxy


# Create non-root user with passwordless sudo
RUN useradd -m -s /bin/bash iterate && \
    echo 'iterate ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers.d/iterate && \
    chmod 0440 /etc/sudoers.d/iterate

# Create log directories (owned by iterate user so pidnap can write logs)
RUN mkdir -p /var/log/pidnap && \
    chown -R iterate:iterate /var/log/pidnap

# Global npm tools (as root for system-wide access)
RUN npm install -g pnpm tsx pidnap@0.0.0-dev.4

# Copy entry script (needs stable location for ENTRYPOINT)
COPY apps/os/sandbox/entry.sh /app/entry.sh
RUN chmod +x /app/entry.sh

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
    npm install -g @mariozechner/pi-coding-agent@${SANDBOX_PI_CODING_AGENT_VERSION}

RUN curl -fsSL https://opencode.ai/install | bash -s -- --version ${SANDBOX_OPENCODE_VERSION}

# Wrap claude to always use --dangerously-skip-permissions (safe in sandbox)
# Note: npm creates a symlink, must rm first or echo writes through to cli.js
RUN mkdir -p /home/iterate/.local/bin && \
    CLAUDE_BIN=/home/iterate/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js && \
    rm -f /home/iterate/.npm-global/bin/claude && \
    echo '#!/bin/sh' > /home/iterate/.local/bin/claude && \
    echo "exec node $CLAUDE_BIN --dangerously-skip-permissions \"\$@\"" >> /home/iterate/.local/bin/claude && \
    chmod +x /home/iterate/.local/bin/claude

ENV PATH="/home/iterate/.local/bin:$PATH"
ENV PATH="/home/iterate/.opencode/bin:$PATH"

# === Iterate repo ===

ENV ITERATE_REPO=/home/iterate/src/github.com/iterate/iterate

# Build arg is intentionally declared late to keep earlier layers cacheable across commits.
# SANDBOX_ITERATE_REPO_REF: git commit SHA required for build.
ARG SANDBOX_ITERATE_REPO_REF
RUN if [ -z "$SANDBOX_ITERATE_REPO_REF" ]; then \
    echo "ERROR: SANDBOX_ITERATE_REPO_REF is required"; \
    exit 1; \
  fi

# Bundle-based clone (commit SHA required)
COPY iterate.bundle /tmp/iterate.bundle
RUN git clone /tmp/iterate.bundle $ITERATE_REPO && \
    cd $ITERATE_REPO && git checkout "$SANDBOX_ITERATE_REPO_REF"

# Install deps and build daemon
# If Daytona ever supports BuildKit, consider adding:
#   RUN --mount=type=cache,id=pnpm-store,target=/home/iterate/.local/share/pnpm/store \
#     cd $ITERATE_REPO && pnpm install
RUN echo "$SANDBOX_ITERATE_REPO_REF" > /tmp/.iterate-git-ref && \
    cd $ITERATE_REPO && pnpm install
RUN cd $ITERATE_REPO/apps/daemon && npx vite build

# Create .iterate dir with placeholder .env (daemon injects real env vars at runtime)
RUN mkdir -p ~/.iterate && \
    echo "# if you can see this, the daemon hasn't been able to inject env vars yet" > ~/.iterate/.env

# Setup home directory
RUN bash $ITERATE_REPO/apps/os/sandbox/setup-home.sh

ENTRYPOINT [ "/app/entry.sh" ]
