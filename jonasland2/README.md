# jonasland2

Minimal proof of transparent egress plus OpenAPI-first oRPC service architecture:

- Caddy (`:80`, `:443`, admin `:2019`)
- internal MITM certs (`tls internal` + `on_demand`)
- iptables `OUTPUT` REDIRECT on 80/443
- tiny Node egress forwarder behind Caddy
- `events-service` via oRPC `OpenAPIHandler` (`/api/*`)

## Packages

- `sandbox/`: minimal Docker image (`Caddy + iptables + egress`) + build script
- `e2e/`: smoke tests using Docker SDK fixtures + MSW-backed proxy (HTTP + WS)
- `apps/events-contract/`: oRPC contract package
- `apps/events-service/`: contract implementation package (OpenAPI handler + Scalar docs)
- `tasks/`: jonasland2-local task backlog

## Run

```bash
cd jonasland2
pnpm build
pnpm test
```

## SigNoz

```bash
cd jonasland2
pnpm signoz:up
pnpm signoz:status
```

SigNoz UI: `http://127.0.0.1:8080`

Run container and inspect mapped ports:

```bash
docker run -d --name jonasland2-live \
  --cap-add NET_ADMIN \
  --add-host host.docker.internal:host-gateway \
  -e OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://host.docker.internal:4318/v1/traces \
  -P jonasland2-sandbox:local
docker port jonasland2-live
```

Then hit:

- Caddy health on mapped `80/tcp`: `http://127.0.0.1:<PORT>/healthz`
- Caddy admin on mapped `2019/tcp`: `http://127.0.0.1:<PORT>/config/`
- Events API via host header `events.iterate.localhost`:
  - `GET /api/openapi.json`
  - `GET /api/docs` (Scalar UI served by OpenAPI handler plugin)
  - `GET /api/events`
  - `POST /api/events`
