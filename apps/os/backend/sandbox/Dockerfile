FROM docker.io/cloudflare/sandbox:0.4.3

ENV COMMAND_TIMEOUT_MS=360000

# RUN node -v
# # Remove existing Node.js and install Node.js 24
# RUN apt-get remove -y nodejs npm
# RUN apt-get update && apt-get install -y xz-utils
# RUN curl -fsSL https://nodejs.org/dist/v24.10.0/node-v24.10.0-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1 && \
#     ln -sf /usr/local/bin/node /usr/bin/node && \
#     ln -sf /usr/local/bin/npm /usr/bin/npm && \
#     ln -sf /usr/local/bin/npx /usr/bin/npx
# RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
# RUN apt-get update && apt-get install -y nodejs

# # Install pnpm, tsx and openai codex using Node 24
RUN bun install -g @openai/codex@0.46
# add bun global bin to path
ENV PATH="/root/.bun/bin:$PATH"
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
