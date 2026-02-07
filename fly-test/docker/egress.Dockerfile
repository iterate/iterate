FROM golang:1.23-bookworm AS mitm-build
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
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bun.sh/install | bash

COPY --from=mitm-build /out/fly-mitm /usr/local/bin/fly-mitm
RUN chmod +x /usr/local/bin/fly-mitm

COPY egress-proxy /proof/egress-proxy
COPY mitm-go /proof/mitm-go

RUN chmod +x /proof/egress-proxy/start.sh /proof/mitm-go/start.sh
RUN bun --version && test -x /usr/local/bin/fly-mitm

ENTRYPOINT ["/bin/bash", "/proof/egress-proxy/start.sh"]
