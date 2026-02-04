FROM node:24 AS pidnap-builder
WORKDIR /app
RUN corepack enable
COPY packages/pidnap/package.json ./
RUN pnpm install
COPY packages/pidnap/src ./src
COPY packages/pidnap/tsconfig.json packages/pidnap/tsdown.config.ts ./
RUN pnpm build && pnpm pack && mv *.tgz pidnap.tgz

FROM node:24

# === Version Configuration ===
# Edit these to update versions (requires image rebuild)
# Exposed as ENV vars for visibility inside container
ENV SANDBOX_OPENCODE_VERSION=1.1.41
ENV SANDBOX_CLAUDE_CODE_VERSION=2.1.12
ENV SANDBOX_PI_CODING_AGENT_VERSION=0.49.2
ENV SANDBOX_CODEX_VERSION=0.92.0
ENV SANDBOX_BUN_VERSION=1.3.6
ENV SANDBOX_GO_VERSION=1.23.4

# gogcli fork: mmkal:mmkal/26/01/28/--access-token
ENV SANDBOX_GOGCLI_REF=99d957581f61532de08f3847e79f639edad3c68b

# === Build Args ===
# SANDBOX_ITERATE_REPO_REF: git ref (branch/SHA) to clone. If empty, creates placeholder for local mount.
ARG SANDBOX_ITERATE_REPO_REF=""

# === System packages (as root) ===
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y btop build-essential fd-find gh git inotify-tools jq locales make rsync sqlite3 sudo tini tmux && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    ln -s $(which fdfind) /usr/local/bin/fd

# Configure UTF-8 locale (required for btop and other tools)
RUN localedef -i en_US -c -f UTF-8 -A /usr/share/locale/locale.alias en_US.UTF-8
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Create non-root user with passwordless sudo
RUN useradd -m -s /bin/bash iterate && \
    echo 'iterate ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers.d/iterate && \
    chmod 0440 /etc/sudoers.d/iterate

# Create log directories (owned by iterate user so pidnap can write logs)
RUN mkdir -p /var/log/pidnap && \
    chown -R iterate:iterate /var/log/pidnap

# Global npm tools (as root for system-wide access)
RUN npm install -g pnpm tsx serve

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

# === Switch to non-root user ===

USER iterate
WORKDIR /home/iterate

ENV PATH="/home/iterate/.local/bin:$PATH"

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
# Note: go build -o creates parent dirs automatically, but mkdir for clarity
RUN mkdir -p /home/iterate/.local/bin && \
    git clone https://github.com/mmkal/gogcli.git /tmp/gogcli && \
    cd /tmp/gogcli && \
    git checkout ${SANDBOX_GOGCLI_REF} && \
    go build -o /home/iterate/.local/bin/gog ./cmd/gog && \
    rm -rf /tmp/gogcli

# === Agent packages (npm, userspace) ===
RUN npm install -g @mariozechner/pi-coding-agent@${SANDBOX_PI_CODING_AGENT_VERSION} && \
    npm install -g @openai/codex@${SANDBOX_CODEX_VERSION}

RUN curl -fsSL https://claude.ai/install.sh | bash -s -- ${SANDBOX_CLAUDE_CODE_VERSION}

RUN curl -fsSL https://opencode.ai/install | bash -s -- --version ${SANDBOX_OPENCODE_VERSION}
ENV PATH="/home/iterate/.opencode/bin:$PATH"
# Run opencode once to skip the init stuff at runtime, we don't care about the result
RUN opencode run "hello" || true

# Wrap claude to always use --dangerously-skip-permissions (safe in sandbox)
RUN mv ~/.local/bin/claude ~/.local/bin/claude.original && \
    echo '#!/bin/sh' > ~/.local/bin/claude && \
    echo "exec ~/.local/bin/claude.original --dangerously-skip-permissions \"\$@\"" >> ~/.local/bin/claude && \
    chmod +x ~/.local/bin/claude

# Wrap codex to always use --dangerously-bypass-approvals-and-sandbox (safe in sandbox)
RUN CODEX_BIN=$(command -v codex) && \
    echo '#!/bin/sh' > /home/iterate/.local/bin/codex && \
    echo "exec $CODEX_BIN --dangerously-bypass-approvals-and-sandbox \"\$@\"" >> /home/iterate/.local/bin/codex && \
    chmod +x /home/iterate/.local/bin/codex

ENV PATH="/home/iterate/.local/bin:$PATH"

# === Iterate repo ===
# Two modes based on SANDBOX_ITERATE_REPO_REF:
#   - Set: git clone the specified ref (CI/Daytona - fast cached builds)
#   - Empty: create placeholder, a pidnap task syncs from local mount at runtime

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

COPY apps/os/sandbox/entry.sh /app/entry.sh
RUN sudo chmod +x /app/entry.sh

ENTRYPOINT [ "/app/entry.sh" ]
