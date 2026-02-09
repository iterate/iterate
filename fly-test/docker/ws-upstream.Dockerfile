FROM node:24

ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash

COPY ws-upstream /proof/ws-upstream

RUN chmod +x /proof/ws-upstream/start.sh
RUN bun --version

ENTRYPOINT ["/bin/bash", "/proof/ws-upstream/start.sh"]
