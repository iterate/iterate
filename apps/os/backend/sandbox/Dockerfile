FROM docker.io/cloudflare/sandbox:0.4.4 AS builder
COPY scripts/package.json /tmp/package.json
RUN npm install -g pnpm@10
RUN cd /tmp && pnpm install
# Copy the entire scripts directory so esbuild can resolve local imports
COPY ./scripts /tmp/scripts
RUN cd /tmp && ./node_modules/.bin/esbuild \
    scripts/sandbox-build-runner.ts \
    --bundle \
    --platform=node \
    --format=cjs \
    --target=node24 \
    --outfile=/tmp/sandbox-build-runner.js
RUN cd /tmp && ./node_modules/.bin/esbuild \
    scripts/sandbox-exec-runner.ts \
    --bundle \
    --platform=node \
    --format=cjs \
    --target=node24 \
    --outfile=/tmp/sandbox-exec-runner.js
RUN cd /tmp && ./node_modules/.bin/esbuild \
    scripts/upload-file.ts \
    --bundle \
    --platform=node \
    --format=cjs \
    --target=node24 \
    --outfile=/tmp/upload-file


FROM docker.io/cloudflare/sandbox:0.4.4

ENV COMMAND_TIMEOUT_MS=360000

# Install Node.js 24 in a separate location so it doesn't interfere with existing binaries
RUN apt-get update && apt-get install -y xz-utils
RUN mkdir -p /opt/node24 && \
    curl -fsSL https://nodejs.org/dist/v24.10.0/node-v24.10.0-linux-x64.tar.xz | tar -xJ -C /opt/node24 --strip-components=1

# Install pnpm, tsx and openai codex using the existing node binaries
RUN npm install -g @openai/codex@0.46 tsx@4 pnpm@10

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && \
    apt-get install -y gh

# Configure git
RUN git config --global user.name "iterate" && \
    git config --global user.email "233973017+iterate[bot]@users.noreply.github.com"

# Alias python to python3 because AI often tries to use `python` and if we don't do this there's nothing called python on the path
RUN ln -s /usr/bin/python3 /usr/bin/python

# Configure codex
ENV CODEX_NO_CONFIRM=1

# Create a temporary directory that everyone can use
RUN mkdir -p /tmp/ && chmod 777 /tmp/

COPY ./scripts/sandbox-entry.ts /tmp/sandbox-entry.ts
RUN chmod +x /tmp/sandbox-entry.ts


COPY --from=builder /tmp/sandbox-build-runner.js /tmp/sandbox-build-runner.js
RUN chmod +x /tmp/sandbox-build-runner.js
COPY --from=builder /tmp/sandbox-exec-runner.js /tmp/sandbox-exec-runner.js
RUN chmod +x /tmp/sandbox-exec-runner.js
COPY --from=builder /tmp/upload-file /tmp/upload-file
RUN chmod +x /tmp/upload-file

# Expose the ports you want to expose
EXPOSE 3000
