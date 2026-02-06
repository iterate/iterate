FROM golang:1.25-bookworm AS mitm-build
WORKDIR /src
COPY fly-test/mitm-go/go-mitm/go.mod ./go.mod
COPY fly-test/mitm-go/go-mitm/go.sum ./go.sum
COPY fly-test/mitm-go/go-mitm/main.go ./main.go
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
  unzip \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash
RUN curl -LsSf https://astral.sh/uv/install.sh | bash
RUN /root/.local/bin/uv tool install mitmproxy && ln -sf /root/.local/bin/mitmdump /usr/local/bin/mitmdump

RUN ARCH="$(uname -m)" && \
  case "$ARCH" in \
    x86_64) ASSET="cloudflared-linux-amd64" ;; \
    aarch64|arm64) ASSET="cloudflared-linux-arm64" ;; \
    *) echo "unsupported arch: $ARCH" && exit 1 ;; \
  esac && \
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${ASSET}" -o /usr/local/bin/cloudflared && \
  chmod +x /usr/local/bin/cloudflared

COPY --from=mitm-build /out/fly-mitm /usr/local/bin/fly-mitm
RUN chmod +x /usr/local/bin/fly-mitm

COPY fly-test/egress-proxy /proof/egress-proxy
COPY fly-test/mitm-go /proof/mitm-go
COPY fly-test/mitm-dump /proof/mitm-dump
COPY fly-test/sandbox /proof/sandbox

WORKDIR /proof/egress-proxy
RUN bun install
WORKDIR /proof/sandbox
RUN bun install
WORKDIR /proof

RUN chmod +x /proof/egress-proxy/start.sh /proof/sandbox/start.sh /proof/mitm-go/start.sh /proof/mitm-dump/start.sh
RUN bun --version && cloudflared --version && /usr/local/bin/fly-mitm --help >/dev/null && mitmdump --version >/dev/null
