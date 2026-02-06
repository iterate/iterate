# fly-test

Super minimal Fly Machines topology runner.

## Files

- `fly-test/topology.json`: Desired topology (app + machine regions)
- `fly-test/apply-topology.ts`: Create app (if missing) + create missing machines

## Usage

Dry run:

```bash
doppler run --config dev -- pnpm tsx fly-test/apply-topology.ts --config fly-test/topology.json --dry-run
```

Apply:

```bash
doppler run --config dev -- pnpm tsx fly-test/apply-topology.ts --config fly-test/topology.json
```

If app is new, allocate public IPv4 once:

```bash
fly ips allocate-v4 -a iterate-fly-test
```

## Notes

- Expects `FLY_API_KEY` in env (you said this already exists in Doppler).
- Script is additive only: it creates missing app/machines and skips existing ones.
- Edit `topology.json` only; no code change needed for regions/names/image.
- If you need a specific Fly private network, add `"network": "<network-name>"` to `topology.json`.

## Cloudflared E2E

This verifies end-to-end:

- install `cloudflared` inside a Fly machine
- run `python3 -m http.server` inside that machine
- create `trycloudflare.com` tunnel to `127.0.0.1:8080`
- fetch tunnel URL from host and assert marker response

Run:

```bash
doppler run --config dev -- bash fly-test/e2e-cloudflared.sh
```

Artifacts are written under:

```bash
fly-test/proof-logs/iterate-cloudflared-e2e-*/
```

Key files:

- `summary.txt`
- `machine.log`
- `tunnel.log`
- `tunnel-url-from-host.txt`
- `local-response.txt`

## Node Egress Observability E2E

Two `node:24` machines:

- sandbox UI with URL form (`sandbox-ui.mjs`)
- egress proxy + live log viewer (`egress-proxy-and-viewer.mjs`)

Run:

```bash
doppler run --config dev -- pnpm --filter fly-test e2e
```

The script outputs:

- sandbox URL (open in browser)
- egress viewer URL (open in browser, live logs via polling `/tail`)
- terminal tail command:

```bash
doppler run --config dev -- bash fly-test/tail-egress-log.sh <app-name> egress-proxy
```

Package checks:

```bash
pnpm --filter fly-test typecheck
pnpm --filter fly-test test
```

## Cleanup

Delete all machines in all apps visible to this token:

```bash
doppler run --config dev -- bash fly-test/cleanup-all-machines.sh
```

Dry run:

```bash
doppler run --config dev -- bash fly-test/cleanup-all-machines.sh --dry-run
```
