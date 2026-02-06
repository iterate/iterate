FROM node:24

ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  iproute2 \
  iptables \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash

COPY sandbox /proof/sandbox
COPY docker/sandbox-entrypoint.sh /docker/sandbox-entrypoint.sh

WORKDIR /proof/sandbox
RUN bun install

RUN chmod +x /docker/sandbox-entrypoint.sh

ENTRYPOINT ["/bin/bash", "/docker/sandbox-entrypoint.sh"]
