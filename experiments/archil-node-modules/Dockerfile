# Benchmark container for testing pnpm install on Archil vs local disk.
# Installs archil CLI, node, pnpm, git — then runs the benchmark entrypoint.
FROM node:22-bookworm

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install essentials (node:22-bookworm already has node, npm, git, curl)
RUN apt-get update && apt-get install -y \
    sudo fuse3 libfuse2 bc \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate

# Install Archil client
RUN curl -s https://s3.amazonaws.com/archil-client/install | sh || true

# Create a non-root user (archil mount needs sudo)
RUN useradd -m -s /bin/bash bench && echo "bench ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

COPY benchmark.sh /benchmark.sh
RUN chmod +x /benchmark.sh

USER bench
WORKDIR /home/bench

ENTRYPOINT ["/benchmark.sh"]
