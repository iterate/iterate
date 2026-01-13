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

COPY apps/os/sandbox/entry.ts /app/entry.ts

ENTRYPOINT [ "tsx", "entry.ts" ]

# =============================================================================
# TMUX SETUP
# =============================================================================
# tmux-resurrect: saves/restores tmux sessions across server restarts
# Clone directly (no plugin manager needed since we only use one plugin)

RUN git clone https://github.com/tmux-plugins/tmux-resurrect /root/.tmux/plugins/tmux-resurrect

# Copy tmux config with resurrect setup and sync hooks
COPY apps/os/sandbox/tmux.conf /root/.tmux.conf
