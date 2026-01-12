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

RUN git clone https://github.com/iterate/iterate.git /iterate-repo

WORKDIR /iterate-repo

COPY . /iterate-repo

RUN pnpm install

# entry.ts sets up the Go-style checkout path at ~/src/github.com/iterate/iterate by
# symlinking it to /iterate-repo (the build-time checkout). The image build doesn't
# know the runtime home dir, so we standardize on /iterate-repo here and fix up the
# home-based path at container start.
ENTRYPOINT [ "tsx", "apps/os2/sandbox/entry.ts" ]
