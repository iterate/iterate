# Cloudflare edge gate

[`policy.ts`](policy.ts) lists reviewed probes to block before they invoke an Iterate
Worker; [`scripts/cloudflare-edge-gate`](../../scripts/cloudflare-edge-gate) reconciles it.

## Policy workflow

Edit `policy.ts`, preserving evidence and a reason. Unsafe or duplicate paths,
`/.well-known`, and oversized expressions fail validation. Discovery never adds blocks.

```sh
pnpm edge-gate plan --env preview_12
pnpm edge-gate apply --env preview_12
pnpm edge-gate verify --env preview_12
```

It preserves unrelated zone rules, reads back zero drift after apply, and smoke-checks
blocked and control paths. Production applies only on `main`; previews require local apply.
The first pull request needs one `depot ci run --org 0p91s0lz49 --workflow
.depot/workflows/cloudflare-edge-gate.yml`; Depot discovers later automatic triggers from
`main`. There is no teardown command; removal is a separate destructive operation.
