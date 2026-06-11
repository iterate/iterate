# Dev environments

How local development, preview environments, and identities work. The design
rationale lives in [dev-environments-redesign-context.md](dev-environments-redesign-context.md);
this is the operating manual.

## The core model (read this much at minimum)

Every environment is the same primitive: **`alchemy.run.ts` run in the context
of a Doppler config.** `prd` deploys production, `preview_N` deploys a preview
slot, `dev` runs a fully-local server. Scripts never branch on environment
names; the config supplies everything.

Local dev is **fully local**: D1/DOs run in miniflare inside your worktree's
`.alchemy/`, the server listens on a random free port at
`http://os.localhost:<port>` (browsers resolve `*.localhost` to loopback — no
DNS, no certs), and the only external dependency is the shared dev auth at
`https://auth.iterate-dev.com`. Nothing is contested between worktrees: twenty
agents on one machine each run their own isolated environment with the same
shared `dev` config.

Identity is **claims in a JWT** — OS deliberately knows nothing about auth's
user table. In dev and preview, the Doppler config carries a _forge_ private
key, so you can mint a session as anyone, instantly and offline:
`pnpm auth:mint` (see [Acting as users](#acting-as-users-and-admins)).

## Local dev

```bash
pnpm install
pnpm dev          # fully-local OS dev server on http://os.localhost:<port>
```

- `pnpm dev` uses your Doppler-selected config if you've run `doppler setup`
  or set `DOPPLER_CONFIG`; otherwise it defaults to the shared `dev` config,
  which works out of the box — no per-user provisioning.
- The chosen port is baked into the env (`APP_CONFIG_BASE_URL`) at startup and
  recorded in **`apps/os/.alchemy/dev-server.json`** (`{pid, port, baseUrl}`).
  Scripts and CLIs that need "the local dev server" read that file — no
  flags, no guessing. One dev server per worktree: a second `pnpm dev` refuses
  while the first is alive.
- Project hosts work in the browser as `<proj-slug>.os.localhost:<port>`.
  (curl/Node don't resolve `*.localhost` — use `127.0.0.1:<port>` with a Host
  header, or plain `localhost:<port>`.)
- Sign in as a human with Google or email OTP via `auth.iterate-dev.com` — the
  shared `os-local-dev` OAuth client accepts any localhost port. Your identity
  there persists across every worktree and environment on your machine.
- Sign in as an agent/test: mint it (next section). Never script the OAuth
  dance.
- Test emails: any address matching `+...test@` (e.g. `alice+test@nustom.com`)
  gets the fixed OTP `424242` in dev/preview and sends no real email.

The dev-global auth deploys from `main` (alongside prd auth) and reseeds its
OAuth clients from Doppler on every deploy — see
`apps/auth/scripts/seed-oauth-clients.ts`.

Working on the auth app itself? Run it locally
(`pnpm --dir apps/auth dev`) and point OS at it by overriding
`APP_CONFIG_ITERATE_AUTH__ISSUER` (e.g. `http://localhost:7101/api/auth`) in
your env or Doppler branch config.

## Acting as users and admins

OS trusts JWTs signed by any key in its baked JWKS. Dev and preview configs
include the **forge** public key, whose private half is in Doppler
(`AUTH_FORGE_PRIVATE_JWK`, inherited from `_shared/dev` / `_shared/preview`).
Minting is offline and instant — no auth worker involved:

```bash
# a regular user (defaults shown)
doppler run --project os --config dev -- pnpm auth:mint --email alice+test@nustom.com

# platform admin
doppler run --project os --config dev -- pnpm auth:mint --admin

# print only a one-shot browser sign-in URL
doppler run --project os --config dev -- pnpm auth:mint --admin --browser-url

# against a preview slot
doppler run --project os --config preview_3 -- pnpm auth:mint --email e2e+test@nustom.com
```

The output gives you three ways in:

1. **API**: `Authorization: Bearer <accessToken>` on any OS endpoint.
2. **Browser**: navigate to `browserSignInUrl`
   (`/api/iterate-auth/session-from-token?...`) — it validates the tokens and
   sets the normal session cookie, then redirects. Works for Playwright,
   agent-browser, and pasting into a real browser. This is THE way to point a
   browser at a local dev server or preview environment as a chosen identity.
3. **Claims**: pass `--orgs/--projects/--claims` JSON to mint membership of
   specific orgs/projects, since authorization is claims-driven.

There is intentionally **no forge key in prd** (the deploy fails if one
appears in a prd config). Production access uses the existing admin API
secret; an audited mint-endpoint on the auth worker is the planned
replacement.

## Browsers: the golden path for agents

1. If your agent environment has a built-in browser (Cursor, Devin, …), use
   that.
2. Otherwise use **agent-browser against a dedicated headless Chrome** — never
   attach to the user's running Chrome unless they explicitly asked (the
   attach prompt requires human approval; an AFK user means you hang forever):

```bash
# one-time: agent-browser install
BIN="$HOME/.agent-browser/browsers/"*"/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
nohup "$BIN" --headless=new --remote-debugging-port=9444 --user-data-dir=/tmp/ab-own about:blank >/dev/null 2>&1 & disown

AGENT_BROWSER_AUTO_CONNECT=0 agent-browser --cdp 9444 open "$(doppler run --project os --config dev -- pnpm --silent auth:mint --browser-url)"
AGENT_BROWSER_AUTO_CONNECT=0 agent-browser --cdp 9444 snapshot -i
```

(`AGENT_BROWSER_AUTO_CONNECT=0` matters: some machines default agent-browser
to auto-attaching to the user's real Chrome.) Run agent-browser commands
serially — concurrent invocations wedge its daemon.

3. Driving the user's actual Chrome (to reuse their session or look at their
   tabs) is allowed **only when the user explicitly asks**; then use the
   chrome-devtools MCP / `--auto-connect` knowingly.

## Preview environments

Each preview slot N is a complete, isolated stack on the dev/preview
Cloudflare account: `os.iterate-preview-N.com`, `auth.iterate-preview-N.com`,
and `<proj-slug>.iterate-preview-N.app`. Slots are leased via semaphore
(`environment-config-lease`, slugs `preview-1..9`); CI acquires a lease per
PR, deploys the slot's auth first (OS bakes its JWKS from it), then OS, runs
e2e, and destroys + releases on PR close.

The slot's OS↔auth OAuth client credentials are **constants in Doppler**
(`auth/preview_N` carries `AUTH_SEED_OAUTH_CLIENTS`; `os/preview_N` carries
the matching `APP_CONFIG_ITERATE_AUTH__*`). Every auth deploy reseeds them
into its database, so the DB can never drift from Doppler and the two apps
need no deploy-time coordination. Provisioning/rotation:
`pnpm tsx scripts/preview/provision-auth-preview-configs.ts [--rotate]`.

### Creating a preview environment from your machine

CI is just a thin wrapper — everything reproduces locally:

```bash
# 1. Lease a slot first (otherwise a PR's cleanup can destroy your deploy):
doppler run --project _shared --config prd -- pnpm preview status
# acquire programmatically (3h):
doppler run --project _shared --config prd -- pnpm tsx -e '...' # see scripts/preview/router.ts; or use the preview CLI with a PR number

# 2. Deploy (same primitive as everything else):
cd apps/auth && doppler run --project auth --config preview_9 -- pnpm alchemy:up
cd ../os    && doppler run --project os   --config preview_9 -- pnpm tsx ./alchemy.run.ts

# 3. Point a browser at it:
doppler run --project os --config preview_9 -- pnpm auth:mint --admin --browser-url
# open the printed URL — you're signed in on https://os.iterate-preview-9.com

# 4. Tear down when done:
cd apps/os   && doppler run --project os   --config preview_9 -- pnpm tsx ./alchemy.run.ts --destroy
cd ../auth   && doppler run --project auth --config preview_9 -- pnpm alchemy:up --destroy
```

For the PR-centric flow (managed PR comment, tests, cleanup) use
`pnpm preview sync|deploy|test|cleanup --pull-request-number N` under
`doppler run --project _shared --config prd` — see
[devops-cloudflare-doppler-alchemy-setup.md](devops-cloudflare-doppler-alchemy-setup.md).

## Tunnels and webhooks

Inbound webhooks (Slack, GitHub) and third-party OAuth callbacks need a
public HTTPS hostname — that's the only reason to reach for a tunnel from
fully-local dev.

The **iterate tunnel gateway** (`apps/tunnels`, deployed at
`tunnels.iterate.com`) mints public tunnels on demand: any caller dials it
with the shared gateway secret (`CAPTUN_TOKEN`, in Doppler `_shared/dev` and
`_shared/preview`) and gets `<name>.tunnels.iterate.com` in ~200ms. It's a
standalone captun worker — deliberately not embedded in OS, so it stays tiny
and outlives any app deploy. Enable it for your dev server with env vars only
(no code change):

```bash
CAPTUN_ENABLED=true pnpm dev          # random tunnel name on the default gateway
CAPTUN_TUNNEL_NAME=jonas pnpm dev     # stable name → https://jonas.tunnels.iterate.com
```

The captun Vite plugin (`apps/os/vite.config.ts`) activates when
`CAPTUN_ENABLED`/`CAPTUN_TUNNEL_NAME` is set and forwards public **HTTP** to
your local dev server. Its forwarder is plain `fetch`, so it does **not** carry
WebSockets — HMR and itx (`/api/itx`, capnweb-over-WS) stay on the local URL.

For WebSocket traffic over the tunnel (e.g. driving itx against a local dev
server from outside), use the captun **CLI** instead, which forwards WS via
captun@27's `connectWebSocket` hook:

```bash
captun tunnel http://127.0.0.1:<port> \
  --name <name> --gateway https://tunnels.iterate.com --token "$CAPTUN_TOKEN"
# → https://<name>.tunnels.iterate.com  (HTTP + WebSockets)
# then: connectItx({ baseUrl: "https://<name>.tunnels.iterate.com", token: <admin> })
```

(Wiring `connectWebSocket` into the Vite plugin so `pnpm dev` carries WS too is
a small captun follow-up.) Tests open tunnels via `createPublicTunnel`
(`apps/os/e2e/test-support/create-test-project.ts`) against the same gateway.

Tunnels are not scarce. The genuinely scarce thing is the webhook-source
configuration — a Slack app points at exactly one delivery URL at a time —
so set a stable `CAPTUN_TUNNEL_NAME` per person (held in `dev_<user>`) to
keep that URL working.

## Slack end-to-end testing

See [slack-smoke-testing.md](slack-smoke-testing.md). Slack requires public
HTTPS webhooks, so this runs against deployed environments / tunnel-backed
dev, not plain-localhost dev.
