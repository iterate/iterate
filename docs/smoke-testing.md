# Smoke-Testing A Deployment

How an agent (or a human) convinces themselves a deployed OS environment —
especially production — is actually alive. Recipes only; every command below
exists and the cheap ones were run against a live environment before being
written down. For the full lane/environment matrix see
[Testing](testing.md).

## What runs automatically on every deploy

`pnpm run deploy` (apps/os/scripts/deploy.ts, pipeline in
`scripts/lib/deploy-helpers.ts`) refuses to report success until the env
answers. Each probe retries up to 18 times, 5s apart (~90s window — a fresh
worker version can 503 at the edge for tens of seconds while it propagates):

1. **Dashboard** — `GET <baseUrl>/` must answer 200 or a 3xx redirect
   (anonymous prod answers 307 to sign-in; that counts).
2. **Event docs** — `GET <eventDocsBaseUrl>/` must answer 200.
3. **os api** — `GET <baseUrl>/api` must answer below 500 (a 400 for a
   GET without an RPC body is a healthy worker).
4. **auth Workers RPC proof** (after deploy) — fetch
   `https://<random-uuid>.<projectHostnameBase>/` and require the **exact
   OS project-miss body**: status 404 with JSON `{"error":"not found"}`.
   A fresh hostname can't hit the KV cache or the isolate's negative memo,
   so this proves ingress reached `getProjectBySlug()` on the auth worker's
   RPC entrypoint; an edge/router 404 with any other body fails the deploy.

Before any of that, the deploy fail-fasts on config: every required Doppler
secret present, the exact runtime env validated with the worker's own zod
schema (`parseConfig`), and the retired auth service token asserted absent
from both Doppler and the live Worker.

## Manual / agent recipes

All from `apps/os` unless noted. The Doppler config picks the environment
(`dev` needs `pnpm dev` running; `preview_N`; `prd`).

### Full e2e lane against any environment

```bash
doppler run --config prd -- pnpm e2e            # everything, vs production
doppler run --config preview_3 -- pnpm e2e      # vs a preview slot
doppler run --config dev -- pnpm e2e            # vs your local dev server
```

### The targeted preview smoke (one test, ~8s)

Creates a disposable project, hits its MCP route, proves the seed path:

```bash
doppler run --config preview_3 -- pnpm e2e -t "OS preview smoke"
```

### One-command real agent chat proof

`pnpm cli itx agent-smoke` sends one user message over itx and waits for the
assistant's reply — a full LLM turn through the deployed stack. Create a
throwaway project first; full walkthrough in
[Agent smoke testing](../apps/os/docs/agent-smoke-testing.md):

```bash
doppler run --project os --config prd -- pnpm cli itx run \
  --eval 'return await itx.projects.create({ slug: `agent-smoke-${Date.now()}` }).__describe()'

doppler run --project os --config prd -- pnpm cli itx agent-smoke \
  --project <prj_id> --agent-path /agents/smoke --message "PING"
```

### Probe the itx surface directly

```bash
doppler run --config prd -- pnpm cli itx --help
doppler run --config prd -- pnpm cli itx run --eval 'return await itx.whoami()'
```

### Mint a browser session

```bash
doppler run --project os --config preview_3 -- pnpm auth:mint \
  --email agent+test@nustom.com --browser-url        # repo root
```

Works for dev and previews out of the box. Production minting is gated: the
deploy only bakes the forge key into a prod-serving JWKS when
`AUTH_FORGE_ALLOW_PRODUCTION=true` is set in `os/prd`
(`scripts/lib/bake-auth-jwks.ts`) — handle prod sessions with care.

## What the deleted runtime-smoke used to cover

`apps/os/runtime-smoke.test.ts` (deleted; it was `describe.skip` in CI and
wired to no lane) booted a local dev server and probed three things. The
equivalent manual probes, against any base URL:

```bash
BASE=https://os.iterate.com

# SSR HTML: the sign-in page renders server-side (a local dev server also
# SSRs the "Sign in to OS" heading; prod serves the app shell)
curl -fsS "$BASE/sign-in" | head -c 200        # expect an HTML document

# /api/health: the plain health route
curl -fsS "$BASE/api/health"                   # {"ok":true,"app":"os"}

# Operator sessions: anonymous issuance must be rejected...
curl -sS -o /dev/null -w "%{http_code}\n" -X POST \
  -H "content-type: application/json" \
  -d '{"kind":"admin","operatorId":"smoke"}' \
  "$BASE/api/operator-sessions"                # expect 401

# ...issuance works with the deployment admin secret (prints a redeem URL)...
doppler run --config preview_3 -- sh -c 'curl -fsS -X POST \
  -H "authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET" \
  -H "content-type: application/json" \
  -d "{\"kind\":\"admin\",\"operatorId\":\"smoke\"}" \
  "$APP_CONFIG_BASE_URL/api/operator-sessions"'

# ...and redeeming the token from a foreign Origin must be rejected (403):
# POST the token as text/plain to $BASE/api/operator-sessions/redeem with
# `origin: https://attacker.example` — same-origin redemption sets the
# HttpOnly SameSite=Strict `iterate-operator-session` cookie.
```

Note: the operator-session issue/redeem path (including the cross-origin
rejection) currently has **no automated exercise** — tracked as an open item
in [tasks/testing-strategy.md](../tasks/testing-strategy.md).
