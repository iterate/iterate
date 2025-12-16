FROM node:24

WORKDIR /app

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh

# Install pnpm, tsx, and openai codex
RUN npm install -g @openai/codex@0.46 tsx@4 pnpm@10

# Configure git
RUN git config --global user.name "iterate" && \
    git config --global user.email "233973017+iterate[bot]@users.noreply.github.com"

# Alias python to python3 because AI often tries to use `python`
RUN ln -sf /usr/bin/python3 /usr/bin/python || true

# Configure codex to not require confirmation
ENV CODEX_NO_CONFIRM=1
ENV CI=1

# Create a temporary directory that everyone can use
RUN mkdir -p /tmp/ && chmod 777 /tmp/

# Copy package files and install dependencies
COPY package.json .
RUN pnpm install --no-frozen-lockfile

# Copy the source code
COPY . .

CMD [ "tsx", "src/index.ts" ]

EXPOSE 3000
