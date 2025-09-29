FROM docker.io/cloudflare/sandbox:0.3.2

ENV COMMAND_TIMEOUT_MS=180000

# Install Node.js 24 using NodeSource repository (supports multiple architectures)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g pnpm tsx

# Expose the ports you want to expose
EXPOSE 3000
