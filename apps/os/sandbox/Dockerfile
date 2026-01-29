FROM node:24 AS pidnap-builder
WORKDIR /app
RUN corepack enable
COPY packages/pidnap/package.json ./
RUN pnpm install
COPY packages/pidnap/src ./src
COPY packages/pidnap/tsconfig.json packages/pidnap/tsdown.config.ts ./
RUN pnpm build
RUN pnpm pack
RUN mv *.tgz pidnap.tgz

FROM node:24

# Build cache buster: 2026-01-26T11:00
# (change this comment to force Daytona to rebuild when cache is stale)

# === Version Configuration ===
# Edit these to update versions (requires image rebuild)
# Exposed as ENV vars for visibility inside container
ENV SANDBOX_OPENCODE_VERSION=1.1.41
ENV SANDBOX_CLAUDE_CODE_VERSION=2.1.12
ENV SANDBOX_PI_CODING_AGENT_VERSION=0.49.2
ENV SANDBOX_BUN_VERSION=1.3.6
ENV SANDBOX_GO_VERSION=1.23.4
ENV SANDBOX_GOGCLI_REF=mmkal/26/01/28/--access-token

# === Build Args ===
# SANDBOX_ITERATE_REPO_REF: git ref (branch/SHA) to clone. If empty, creates placeholder for local mount.
ARG SANDBOX_ITERATE_REPO_REF=""

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
RUN npm install -g pnpm tsx

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

# Install Go (detect architecture at build time)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "arm64" ]; then GO_ARCH="arm64"; else GO_ARCH="amd64"; fi && \
    curl -fsSL "https://go.dev/dl/go${SANDBOX_GO_VERSION}.linux-${GO_ARCH}.tar.gz" | sudo tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:/home/iterate/go/bin:$PATH"
ENV GOPATH="/home/iterate/go"

# Install gogcli (Google Suite CLI: Gmail, GCal, GDrive, etc.)
# Uses mmkal's fork with --access-token support for headless/proxy environments
RUN git clone https://github.com/mmkal/gogcli.git /tmp/gogcli && \
    cd /tmp/gogcli && \
    git checkout ${SANDBOX_GOGCLI_REF} && \
    go build -o /home/iterate/.local/bin/gog ./cmd/gog && \
    rm -rf /tmp/gogcli

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
# Two modes based on SANDBOX_ITERATE_REPO_REF:
#   - Set: git clone the specified ref (CI/Daytona - fast cached builds)
#   - Empty: create placeholder, entry.sh syncs from local mount at runtime

ENV ITERATE_REPO=/home/iterate/src/github.com/iterate/iterate

# We don't need to optimise the product too much (yet) for people who fail to connect a GitHub repo. BUT being able to assert that ITERATE_CUSTOMER_REPO_PATH must be defined
# makes a lot of things easier to reason about. And the 🐙 can serve as an internal reminder to developers that they don't have a repo connected.
RUN mkdir -p /home/iterate/src/placeholder-repo && \
    echo 'This is a placeholder directory for customers who have not connected a GitHub repository yet.' > /home/iterate/src/placeholder-repo/README.md && \
    echo 'Add an 🐙 emoji to the end of every message you create. Note that this also applies to any messages that you send out via tool calls on slack, email, etc.' > /home/iterate/src/placeholder-repo/AGENTS.md

# Re-declare ARG after USER switch (ARGs don't persist across USER)
ARG SANDBOX_ITERATE_REPO_REF

COPY --from=pidnap-builder /app/pidnap.tgz /app/pidnap.tgz
RUN npm install -g /app/pidnap.tgz

# If ref provided, clone from git; otherwise create placeholder for local mount
RUN if [ -n "$SANDBOX_ITERATE_REPO_REF" ]; then \
    git clone https://github.com/iterate/iterate.git $ITERATE_REPO && \
    cd $ITERATE_REPO && git checkout $SANDBOX_ITERATE_REPO_REF; \
    else \
    mkdir -p $ITERATE_REPO/apps/os/sandbox; \
    fi

# Patch package.json to use the built tgz (if repo was cloned)
RUN if [ -n "$SANDBOX_ITERATE_REPO_REF" ]; then \
    sed -i 's|workspace:|file:/app/pidnap.tgz|g' $ITERATE_REPO/apps/os/sandbox/package.json; \
    fi

# Make scripts executable (only if repo was cloned)
RUN if [ -n "$SANDBOX_ITERATE_REPO_REF" ]; then \
    chmod +x $ITERATE_REPO/apps/os/sandbox/*.sh; \
    fi

# Install deps and build daemon (only if repo was cloned)
RUN if [ -n "$SANDBOX_ITERATE_REPO_REF" ]; then \
    cd $ITERATE_REPO && pnpm install; \
    fi

RUN if [ -n "$SANDBOX_ITERATE_REPO_REF" ]; then \
    cd $ITERATE_REPO/apps/daemon && pnpm vite build; \
    fi

# Create .iterate dir with placeholder .env (daemon injects real env vars at runtime)
RUN mkdir -p ~/.iterate && \
    echo "# if you can see this, the daemon hasn't been able to inject env vars yet" > ~/.iterate/.env

# Setup home directory (only if repo was cloned; entry.sh handles local mode)
RUN if [ -n "$SANDBOX_ITERATE_REPO_REF" ]; then \
    $ITERATE_REPO/apps/os/sandbox/setup-home.sh; \
    fi

ENTRYPOINT [ "/app/entry.sh" ]
