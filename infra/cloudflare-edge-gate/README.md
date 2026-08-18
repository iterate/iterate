# Cloudflare edge gate

This isolated Alchemy v2 stack blocks a deliberately small, reviewed set of source- and
secret-disclosure probes in Cloudflare's `http_request_firewall_custom` phase, before a
request can invoke an Iterate Worker.

## Policy workflow

Edit [`policy.ts`](policy.ts), preserving a reason, observation date, production request
count, and evidence source for every exact path. The compiler rejects uppercase or
non-exact paths, duplicates, `/.well-known`, missing evidence, and expressions over
Cloudflare's size limit. Candidate discovery stays read-only and never promotes a path to
`block` automatically.

```sh
pnpm --dir infra/cloudflare-edge-gate test
pnpm --dir infra/cloudflare-edge-gate typecheck
```

Production uses an Enterprise account custom ruleset plus the account phase entrypoint,
limited to `iterate.app` and `iterate.com`. Preview uses a zone phase entrypoint because
the preview zones are on the Free plan. Both resource forms own the complete rule array
they manage. Before the first deployment to an environment, inventory that phase and
confirm it is empty; after adoption, Alchemy plans expose drift before an apply.

## State and deployment

`Cloudflare.state()` stores shared Alchemy state in a small Worker and Durable Object in
the authenticated Cloudflare account. This is intentionally separate from the repo's
normal Worker deployment machinery. Bootstrap happens once per account/profile, not once
per preview slot.

The target comes from the canonical root `envs.ts`. `EDGE_GATE_ENV` accepts `prd` or a
configured `preview_N`; the stack refuses an unknown target or a Doppler account mismatch.
Use one Alchemy stage per environment so state cannot cross targets.

```sh
# Configure/bootstrap the dev-preview account once.
CI=true doppler run --project _shared --config preview -- \
  pnpm --dir infra/cloudflare-edge-gate exec alchemy login --profile iterate-preview
CI=true doppler run --project _shared --config preview -- \
  pnpm --dir infra/cloudflare-edge-gate exec alchemy cloudflare bootstrap \
  --profile iterate-preview

# Preview plan and apply.
EDGE_GATE_ENV=preview_19 CI=true \
  doppler run --project _shared --config preview \
  --preserve-env=EDGE_GATE_ENV,CI -- \
  pnpm --dir infra/cloudflare-edge-gate plan \
  --stage preview_19 --profile iterate-preview
EDGE_GATE_ENV=preview_19 CI=true \
  doppler run --project _shared --config preview \
  --preserve-env=EDGE_GATE_ENV,CI -- \
  pnpm --dir infra/cloudflare-edge-gate run deploy \
  --stage preview_19 --profile iterate-preview --yes

# Production is the same shape with _shared/prd, EDGE_GATE_ENV=prd,
# stage prd, and a separately bootstrapped iterate-prd profile.
```

Never run `alchemy destroy` for this stack: Alchemy empties a managed phase entrypoint on
destroy. Production apply belongs in a protected workflow after a reviewed plan and a
read-back of the deployed entrypoint.

`.depot/workflows/cloudflare-edge-gate.yml` runs that production plan for relevant pull
requests and applies it after the reviewed change reaches `main`. It uses the fixed
`deploy-cloudflare-edge-gate-production` concurrency group and never cancels an active
credentialed apply.
