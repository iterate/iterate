FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

# Clone the real iterate repo so we test with a workspace project
RUN git clone --depth 1 https://github.com/iterate/iterate.git /opt/iterate

# Create the target directory on "local disk"
RUN mkdir -p /var/local-node-modules

COPY test.sh /test.sh
RUN chmod +x /test.sh

CMD ["/test.sh"]
