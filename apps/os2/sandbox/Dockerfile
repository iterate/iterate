FROM node:24

WORKDIR /app

RUN npm install -g pnpm@10 tsx@4 @mariozechner/pi-coding-agent

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh s6

RUN curl -fsSL https://opencode.ai/install | bash

RUN curl -fsSL https://claude.ai/install.sh | bash

RUN git config --global user.name "iterate" && \
    git config --global user.email "233973017+iterate[bot]@users.noreply.github.com"

# Clone iterate repo and install dependencies (baked into image for faster startup)
# Using Go-style path: $HOME/src/github.com/{owner}/{repo}
RUN mkdir -p /root/src/github.com/iterate && \
    git clone https://github.com/iterate/iterate.git /root/src/github.com/iterate/iterate && \
    cd /root/src/github.com/iterate/iterate && \
    pnpm install

# Copy s6 service definitions and scripts (until these are merged to main)
COPY s6-daemons /root/src/github.com/iterate/iterate/s6-daemons
COPY scripts /root/src/github.com/iterate/iterate/scripts

COPY apps/os2/sandbox/entry.ts /app/entry.ts

ENTRYPOINT [ "tsx", "entry.ts" ]