FROM docker.io/cloudflare/sandbox:0.3.2

ENV COMMAND_TIMEOUT_MS=180000

# Remove existing Node.js and install Node.js 24
RUN apt-get remove -y nodejs npm && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then NODE_ARCH="x64"; \
    elif [ "$ARCH" = "aarch64" ]; then NODE_ARCH="arm64"; \
    else echo "Unsupported architecture: $ARCH" && exit 1; fi && \
    curl -fsSL "https://nodejs.org/dist/v24.0.0/node-v24.0.0-linux-${NODE_ARCH}.tar.xz" | tar -xJ -C /usr/local --strip-components=1 && \
    ln -sf /usr/local/bin/node /usr/bin/node && \
    ln -sf /usr/local/bin/npm /usr/bin/npm && \
    ln -sf /usr/local/bin/npx /usr/bin/npx

# Install pnpm and tsx using Node 24
RUN npm install -g pnpm tsx

# Expose the ports you want to expose
EXPOSE 3000
