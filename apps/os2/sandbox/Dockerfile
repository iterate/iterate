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
# Uses user-agnostic path; entry.ts creates symlink to Go-style path at runtime
RUN git clone https://github.com/iterate/iterate.git /iterate-repo && \
    cd /iterate-repo && \
    pnpm install

# Copy entry script (only file needed from build context)
COPY entry.ts /app/entry.ts

# Development: Mount local iterate repo to override the baked-in clone:
#   docker run -v /path/to/local/iterate:/iterate-repo -e ITERATE_DEV=true ...
# Set ITERATE_DEV=true to skip git fetch/reset (preserves your local changes).

ENTRYPOINT [ "tsx", "entry.ts" ]