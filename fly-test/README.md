# fly-test

Minimal Fly Machines playground for sandbox-egress observability.

## Layout

- `fly-test/e2e/run-observability.ts`: single canonical e2e runner
- `fly-test/e2e/run-observability-lib.ts`: small pure helpers
- `fly-test/e2e/run-observability.test.ts`: unit tests for helpers
- `fly-test/sandbox/server.ts`: Bun full-stack server + `/api/fetch`
- `fly-test/sandbox/client.tsx`: React sandbox UI
- `fly-test/sandbox/index.html`: sandbox shell + Tailwind CDN
- `fly-test/sandbox/package.json`, `fly-test/sandbox/tsconfig.json`: sandbox app package config
- `fly-test/sandbox/start.sh`: machine init + cloudflared tunnel for sandbox
- `fly-test/egress-proxy/server.ts`: Bun egress service (`/api/fetch`) + viewer API
- `fly-test/egress-proxy/client.tsx`: React live log viewer
- `fly-test/egress-proxy/index.html`: viewer shell + Tailwind CDN
- `fly-test/egress-proxy/package.json`, `fly-test/egress-proxy/tsconfig.json`: egress app package config
- `fly-test/egress-proxy/start.sh`: machine init + cloudflared tunnel for viewer
- `fly-test/scripts/tail-egress-log.sh`: tail proxy log from terminal
- `fly-test/scripts/cleanup-all-machines.sh`: delete all machines in account/org

## Quick Run

```bash
doppler run --config dev -- pnpm --filter fly-test e2e
```

This prints:

- sandbox URL (use form to trigger outbound traffic)
- egress viewer URL (live polling log page)
- tail command
- destroy command

## Proving It Works

The e2e runner does this automatically:

1. Creates Fly app + 2 machines (`node:24`)
2. Installs Bun on each machine and starts sandbox + egress services
3. Gets both Cloudflare tunnel URLs
4. Calls sandbox API endpoint, which calls egress `/api/fetch` for outbound HTTP
5. Pulls machine logs and asserts:
   - sandbox log has `FETCH_OK` or `FETCH_ERROR`
   - egress log has egress events (`FETCH_START` / `FETCH_OK` / `FETCH_ERROR`)

Artifacts land in:

```bash
fly-test/proof-logs/<app-name>/
```

## Useful Commands

Typecheck + unit tests:

```bash
pnpm --filter fly-test typecheck
pnpm --filter fly-test test
```

Tail egress log:

```bash
doppler run --config dev -- pnpm --filter fly-test tail:egress-log <app-name> egress-proxy
```

Cleanup all machines:

```bash
doppler run --config dev -- pnpm --filter fly-test cleanup:all-machines
```

Dry run:

```bash
doppler run --config dev -- pnpm --filter fly-test cleanup:all-machines -- --dry-run
```
