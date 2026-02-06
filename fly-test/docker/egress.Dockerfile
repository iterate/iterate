FROM golang:1.25-bookworm AS mitm-build
WORKDIR /src
COPY mitm-go/go-mitm/go.mod ./go.mod
COPY mitm-go/go-mitm/go.sum ./go.sum
COPY mitm-go/go-mitm/main.go ./main.go
RUN /usr/local/go/bin/go mod download
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 /usr/local/go/bin/go build -trimpath -ldflags "-s -w" -o /out/fly-mitm ./

FROM node:24

ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:${PATH}

RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  openssl \
  python3 \
  python3-venv \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
RUN curl -LsSf https://astral.sh/uv/install.sh | bash
RUN /root/.local/bin/uv tool install mitmproxy && ln -sf /root/.local/bin/mitmdump /usr/local/bin/mitmdump

COPY --from=mitm-build /out/fly-mitm /usr/local/bin/fly-mitm
RUN chmod +x /usr/local/bin/fly-mitm

COPY egress-proxy /proof/egress-proxy
COPY mitm-go /proof/mitm-go
COPY mitm-dump /proof/mitm-dump
COPY docker/egress-entrypoint.sh /docker/egress-entrypoint.sh

WORKDIR /proof/egress-proxy
RUN bun install

RUN chmod +x /docker/egress-entrypoint.sh
RUN chmod +x /proof/mitm-go/start.sh /proof/mitm-dump/start.sh
RUN mitmdump --version >/dev/null

ENTRYPOINT ["/bin/bash", "/docker/egress-entrypoint.sh"]
