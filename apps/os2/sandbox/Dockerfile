FROM node:24

WORKDIR /app

RUN npm install -g pnpm@10 tsx@4

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh

RUN git config --global user.name "iterate" && \
    git config --global user.email "233973017+iterate[bot]@users.noreply.github.com"

COPY entry.ts /app/entry.ts

ENTRYPOINT [ "tsx", "entry.ts" ]