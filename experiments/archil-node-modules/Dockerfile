FROM node:22-bookworm

RUN apt-get update && apt-get install -y sudo fuse3 libfuse2 bc \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.24.0 --activate
RUN curl -s https://s3.amazonaws.com/archil-client/install | sh || true
RUN useradd -m -s /bin/bash bench \
    && echo "bench ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

COPY benchmark.sh /benchmark.sh
RUN chmod +x /benchmark.sh

USER bench
WORKDIR /home/bench
ENTRYPOINT ["/benchmark.sh"]
