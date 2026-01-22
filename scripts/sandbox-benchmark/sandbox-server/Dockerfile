# Benchmark sandbox server Dockerfile
#
# This image runs the benchmark server inside sandboxes.
# It provides:
# - HTTP server for latency measurements (GET /ping)
# - WebSocket terminal for debugging (ws://host/ws/terminal)
# - Boot callback to benchmark runner

FROM node:22-slim

# Install build dependencies for node-pty
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and tsconfig for compilation
COPY package.json tsconfig.json ./

# Install dependencies (including devDependencies for tsc)
RUN npm install

# Copy server code
COPY server.ts terminal.ts ./

# Compile TypeScript to JavaScript
RUN npx tsc

# Expose server port
EXPOSE 8080

# Environment variables (set by benchmark runner)
# BENCHMARK_CALLBACK_URL - URL to POST callback on boot
# BENCHMARK_SANDBOX_ID - Unique sandbox ID
# BENCHMARK_PORT - Server port (default 8080)

# Start server using compiled JS
ENTRYPOINT ["node", "dist/server.js"]
