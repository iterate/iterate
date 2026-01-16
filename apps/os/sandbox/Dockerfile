FROM node:24

# === Version Configuration ===
# Edit these to update versions (requires image rebuild)
# Exposed as ENV vars for visibility inside container
ENV SANDBOX_OPENCODE_VERSION=1.1.23
ENV SANDBOX_CLAUDE_CODE_VERSION=2.1.9
ENV SANDBOX_PI_CODING_AGENT_VERSION=0.47.0
ENV SANDBOX_BUN_VERSION=1.3.6

# SANDBOX_ITERATE_GIT_REF is also a build ARG so CI can override: --build-arg SANDBOX_ITERATE_GIT_REF=feature-branch
ARG SANDBOX_ITERATE_GIT_REF=main
ENV SANDBOX_ITERATE_GIT_REF=${SANDBOX_ITERATE_GIT_REF}

# === System packages (as root) ===

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y btop fd-find gh rsync s6 sudo tmux && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    ln -s $(which fdfind) /usr/local/bin/fd

# Create non-root user with passwordless sudo
RUN useradd -m -s /bin/bash iterate && \
    echo 'iterate ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers.d/iterate && \
    chmod 0440 /etc/sudoers.d/iterate

# Create s6 log directories (owned by iterate user so services can write logs)
RUN mkdir -p /var/log/iterate-daemon /var/log/opencode /var/log/example-service-b && \
    chown -R iterate:iterate /var/log/iterate-daemon /var/log/opencode /var/log/example-service-b

# Global npm tools (as root for system-wide access)
RUN npm install -g pnpm tsx

# Copy entry script and s6 daemon definitions
COPY apps/os/sandbox/entry.sh /app/entry.sh
RUN chmod +x /app/entry.sh
COPY --chown=iterate:iterate apps/os/sandbox/s6-daemons /app/s6-daemons
RUN chmod +x /app/s6-daemons/*/run /app/s6-daemons/*/log/run 2>/dev/null || true

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
    npm install -g opencode-ai@${SANDBOX_OPENCODE_VERSION}

# Wrap claude to always use --dangerously-skip-permissions (safe in sandbox)
# Note: npm creates a symlink, must rm first or echo writes through to cli.js
RUN mkdir -p /home/iterate/.local/bin && \
    CLAUDE_BIN=/home/iterate/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js && \
    rm -f /home/iterate/.npm-global/bin/claude && \
    echo '#!/bin/sh' > /home/iterate/.local/bin/claude && \
    echo "exec node $CLAUDE_BIN --dangerously-skip-permissions \"\$@\"" >> /home/iterate/.local/bin/claude && \
    chmod +x /home/iterate/.local/bin/claude
ENV PATH="/home/iterate/.local/bin:$PATH"

# === Iterate (from source) ===

RUN mkdir -p /home/iterate/src/github.com/iterate && \
    git clone --branch ${SANDBOX_ITERATE_GIT_REF} https://github.com/iterate/iterate.git /home/iterate/src/github.com/iterate/iterate && \
    cd /home/iterate/src/github.com/iterate/iterate && \
    pnpm install && \
    cd apps/daemon && npx vite build

# Create .iterate dir with placeholder .env (daemon injects real env vars at runtime)
RUN mkdir -p ~/.iterate && \
    echo "# if you can see this, the daemon hasn't been able to inject env vars yet" > ~/.iterate/.env

# Copy agent configs (Claude Code, OpenCode, Pi) from repo to $HOME
# This gives agents pre-configured settings (e.g. provider defaults)
# Note: These are copies, not symlinks. In Daytona containers, to update configs
# after image build, manually copy from ~/src/github.com/iterate/iterate/apps/os/sandbox/home-skeleton/
RUN cp -r /home/iterate/src/github.com/iterate/iterate/apps/os/sandbox/home-skeleton/. /home/iterate/

ENTRYPOINT [ "/app/entry.sh" ]
