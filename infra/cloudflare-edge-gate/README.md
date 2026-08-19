# Cloudflare edge gate

[`policy.ts`](policy.ts) lists reviewed probes to block before they invoke an Iterate
Worker; [`scripts/cloudflare-edge-gate`](../../scripts/cloudflare-edge-gate) reconciles it.

## Policy workflow

Edit `policy.ts` to add an exact `path` or an `extension`, preserving production evidence
and a reason. Unsafe or duplicate values, `/.well-known`, and oversized expressions fail
validation. Extensions are platform-wide route constraints: `php` is safe because Iterate
runs Workers, not PHP. External discovery lists remain candidate sources and are never
imported without review.

```sh
pnpm edge-gate plan --env preview_12
pnpm edge-gate apply --env preview_12
pnpm edge-gate verify --env preview_12
```

It preserves unrelated zone rules, reads back zero drift after apply, and smoke-checks an
exact path, an extension, and a control path. Production applies only on `main`; previews
require local apply. There is no teardown command; removal is a separate destructive
operation.
