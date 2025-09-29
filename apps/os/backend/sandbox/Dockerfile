FROM docker.io/cloudflare/sandbox:0.3.2

ENV COMMAND_TIMEOUT_MS=180000

# Install Node.js 24 using NodeSource repository (supports multiple architectures)
# RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
#     apt-get install -y nodejs && \
#     npm install -g pnpm tsx

# seems like the base image has npm already? https://hub.docker.com/layers/cloudflare/sandbox/0.0.0-0dad837-beta/images/sha256-7e55790050f562049cdd2292a57e9404b480de1c5fcba50417b2836542a4e68b
# RUN npm install -g pnpm tsx

# Expose the ports you want to expose
EXPOSE 3000
