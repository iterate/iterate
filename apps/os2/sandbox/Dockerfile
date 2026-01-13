FROM node:24

WORKDIR /app

RUN npm install -g pnpm@10 tsx@4 @mariozechner/pi-coding-agent@0.44.0

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh s6 tmux && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Ensure /var/log exists (permissions set later)
RUN mkdir -p /var/log

RUN git clone https://github.com/iterate/iterate.git /iterate-repo

WORKDIR /iterate-repo

COPY . /iterate-repo

RUN pnpm install

# Build daemon2 frontend (static assets served by the Hono server)
RUN cd apps/daemon2 && npx vite build

# Install opencode and claude to /usr/local/bin so they work for any user
# (local-docker uses 'node', Daytona uses 'daytona')
RUN curl -fsSL https://opencode.ai/install | bash && \
    mv /root/.local/bin/opencode /usr/local/bin/ 2>/dev/null || true
RUN curl -fsSL https://claude.ai/install.sh | bash && \
    mv /root/.claude/local/claude /usr/local/bin/ 2>/dev/null || \
    mv /root/.local/bin/claude /usr/local/bin/ 2>/dev/null || true

# Create daytona user to match Daytona's expectations, with sudo access
RUN useradd -m daytona && echo "daytona ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/91-daytona

# Give both node and daytona users access to /iterate-repo and /var/log
RUN chown -R node:node /iterate-repo && \
    chmod -R 775 /iterate-repo && \
    chown -R node:node /var/log && \
    chmod -R 775 /var/log

# Default to node user for local-docker (Daytona overrides this)
USER node

# Configure git for node user (daytona user will get configured at runtime if needed)
RUN git config --global user.name "iterate" && \
    git config --global user.email "233973017+iterate[bot]@users.noreply.github.com"

# Health check polls the iterate-server health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD curl -sf http://localhost:3000/api/health || exit 1

# entry.ts sets up the Go-style checkout path at ~/src/github.com/iterate/iterate by
# symlinking it to /iterate-repo (the build-time checkout). The image build doesn't
# know the runtime home dir, so we standardize on /iterate-repo here and fix up the
# home-based path at container start.
ENTRYPOINT [ "tsx", "apps/os2/sandbox/entry.ts" ]
