FROM node:24

WORKDIR /app

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y btop gh rsync s6 tmux && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN git config --global user.name "iterate" && \
    git config --global user.email "233973017+iterate[bot]@users.noreply.github.com"

RUN npm install -g pnpm@10.24.0 tsx@4.20.6 opencode-ai@1.1.17 @anthropic-ai/claude-code@2.1.6 @mariozechner/pi-coding-agent@0.44.0

# Wrap claude to always use --dangerously-skip-permissions (safe in sandbox)
RUN echo '#!/bin/sh' > /usr/local/bin/claude && \
    echo 'exec /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --dangerously-skip-permissions "$@"' >> /usr/local/bin/claude && \
    chmod +x /usr/local/bin/claude

# Cache bust arg - pass hash of entry.ts to invalidate when file changes
ARG ENTRY_TS_HASH=default
COPY apps/os/sandbox/entry.ts /app/entry.ts

RUN mkdir -p ~/.iterate && \
  mkdir -p /usr/local/bin && \
  echo '#!/bin/sh' > /usr/local/bin/iterate && \
  echo 'exec tsx --env-file-if-exists ~/.iterate/.env ~/src/github.com/iterate/iterate/apps/cli/main.ts "$@"' >> /usr/local/bin/iterate && \
  chmod +x /usr/local/bin/iterate

ENTRYPOINT [ "tsx", "entry.ts" ]
