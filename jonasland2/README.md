# jonasland2

Minimal proof that HTTP egress works with no Nomad/Consul/Caddy/console.

## Packages

- `sandbox/`: minimal Docker image + build script
- `e2e/`: smoke tests using Docker SDK fixtures + MSW-backed proxy (HTTP + WS)

## Run

```bash
cd jonasland2
pnpm build
pnpm test
```
