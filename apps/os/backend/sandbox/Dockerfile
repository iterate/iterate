FROM docker.io/cloudflare/sandbox:0.3.2

ENV COMMAND_TIMEOUT_MS=360000

# Remove existing Node.js and install Node.js 24
RUN apt-get remove -y nodejs npm && \
    curl -fsSL https://nodejs.org/dist/v24.0.0/node-v24.0.0-linux-x64.tar.xz | tar -xJ -C /usr/local --strip-components=1 && \
    ln -sf /usr/local/bin/node /usr/bin/node && \
    ln -sf /usr/local/bin/npm /usr/bin/npm && \
    ln -sf /usr/local/bin/npx /usr/bin/npx


# Install pnpm and tsx using Node 24
RUN npm install -g pnpm tsx

COPY build-script.ts /tmp/build-script.ts
RUN chmod +x /tmp/build-script.ts

# Expose the ports you want to expose
EXPOSE 3000
