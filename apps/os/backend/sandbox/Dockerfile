FROM docker.io/cloudflare/sandbox:0.4.3

ENV COMMAND_TIMEOUT_MS=360000

# Install Node.js 24 in a separate location so it doesn't interfere with existing binaries
RUN apt-get update && apt-get install -y xz-utils
RUN mkdir -p /opt/node24 && \
    curl -fsSL https://nodejs.org/dist/v24.10.0/node-v24.10.0-linux-x64.tar.xz | tar -xJ -C /opt/node24 --strip-components=1

# Install pnpm, tsx and openai codex using the existing node binaries
RUN bun install -g @openai/codex@0.46 tsx
# RUN npm install -g pnpm@10.18 tsx@4.20 
# RUN curl -fsSL https://get.pnpm.io/install.sh | ENV="$HOME/.bashrc" SHELL="$(which sh)" PNPM_VERSION=10.18.3 sh -
# RUN npm install -g pnpm@10.18

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh

# Configure git
RUN git config --global user.name "iterate" && \
    git config --global user.email "iterate@iterate.com"

# Configure codex
ENV CODEX_NO_CONFIRM=1

# Create a temporary directory that everyone can use
RUN mkdir -p /tmp/ && chmod 777 /tmp/

COPY sandbox-entry.ts /tmp/sandbox-entry.ts
RUN chmod +x /tmp/sandbox-entry.ts

# Expose the ports you want to expose
EXPOSE 3000
