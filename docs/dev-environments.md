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
`http://localhost:<port>`, and the only external dependency is the shared dev auth at
`https://auth.iterate-dev.com`. OS's full worker topology (the per-DO
workers, see `apps/os/docs/worker-topology.md`) runs inside vite's single
workerd as auxiliary workers — one process, production-shaped cross-script
bindings. Nothing is contested between worktrees: twenty
agents on one machine each run their own isolated environment with the same
shared `dev` config.

Identity is **claims in a JWT** — OS deliberately knows nothing about auth's
user table. Every environment's Doppler config carries a _forge_ private key
(prd's behind an explicit opt-in), so you can mint a session as anyone,
instantly and offline: `pnpm auth:mint` (see
[Acting as users](#acting-as-users-and-admins)).

## Local dev

```bash
# once per worktree/clone — doppler.yaml maps each app dir to its Doppler
# project, so this one command scopes the whole monorepo:
pnpm install
doppler setup --config dev --no-interactive       # or --config dev_<you>

pnpm dev          # fully-local OS dev server on http://localhost:<port>
```

- **Config selection**: `pnpm dev` resolves its Doppler config as
  `DOPPLER_CONFIG` env var → `doppler setup` scope for the worktree → shared
  `dev`. The scope (via the repo's `doppler.yaml`) is the intended mechanism;
  the env var is a one-off override.
- **Which config?** `dev`, `dev_jonas`, `dev_misha`, and `dev_rahul` all run
  the same fully-local OS server: random localhost port, per-worktree
  `.alchemy/` state, and human sign-in through `auth.iterate-dev.com`.
  Personal `dev_<you>` configs may still carry personal integration secrets,
  but they should not carry app/MCP/project-host URL overrides. The old
  `os.iterate-dev-<you>.com` hostnames are no longer part of local dev.

  Don't (re)introduce legacy `ITERATE_OAUTH_*` / `ITERATE_AUTH_JWKS` vars in
  these configs: an explicit JWKS in Doppler overrides the deploy-time fetch
  from the auth worker, and a stale one makes OS silently reject every
  session — login just bounces back to `/sign-in` with no error. (This broke
  all `dev_<user>` and preview logins once; cleaned out of `dev_*` and the
  `preview` root on 2026-06-12.)

- The chosen port is recorded in **`apps/os/.alchemy/dev-server.json`**
  (`{pid, port, baseUrl, logPath, stoppedAt?}`).
  When no public app URL is configured, local dev also exposes that URL through
  `APP_CONFIG_BASE_URL`; when `APP_CONFIG.baseUrl` is already set to a public
  captun URL, runtime config keeps the public URL and the discovery file remains
  the local target.
  Scripts and CLIs that need "the local dev server" read that file — no
  flags, no guessing. One dev server per worktree: a second `pnpm dev` refuses
  while the first is alive. The file appears ~10–15s before the port actually
  accepts connections (Vite is still booting) — poll the base URL until it
  returns a response before driving it.
- Dev server output is mirrored to the gitignored
  **`apps/os/.alchemy/dev-server.log`**. Tail it from another terminal with
  `tail -f apps/os/.alchemy/dev-server.log` from the repo root, or
  `tail -f .alchemy/dev-server.log` from `apps/os`.
- Project hosts work in the browser as `<proj-slug>.localhost:<port>`.
  Browser project ingress uses `*.localhost`; curl/Node on macOS usually do
  not resolve those names, so non-browser clients should use
  `localhost:<port>` with a Host header.
- Local MCP is deliberately path-mounted on the curlable app origin:
  `http://localhost:<port>/api/__mcp`. Do not use `mcp.localhost` for local
  scripts unless you have configured local wildcard DNS yourself.
  Smoke it with the MCP Inspector from `apps/os`:

  ```bash
  doppler run --project os --config dev -- sh -lc '
    BASE=$(node -p "require(\"./.alchemy/dev-server.json\").baseUrl")
    npx -y @modelcontextprotocol/inspector --cli "$BASE/api/__mcp" \
      --transport http \
      --method tools/list \
      --header "Authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET"
  '
  ```

  If `tools/list` works, call the smallest harmless tool invocation:

  ```bash
  doppler run --project os --config dev -- sh -lc '
    BASE=$(node -p "require(\"./.alchemy/dev-server.json\").baseUrl")
    npx -y @modelcontextprotocol/inspector --cli "$BASE/api/__mcp" \
      --transport http \
      --method tools/call \
      --tool-name exec_js \
      --tool-arg project=<project-slug> \
      --tool-arg "code=async (itx) => { return await itx.describe(); }" \
      --header "Authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET"
  '
  ```

- Sign in as a human with Google or email OTP via `auth.iterate-dev.com` — the
  shared `os-local-dev` OAuth client accepts any localhost port. Your identity
  there persists across every worktree and environment on your machine.
  Google sign-in needs no per-port (or per-worktree) setup because Google
  never sees your dev server: the only redirect URI it checks is
  `auth.iterate-dev.com`'s own callback, and the OS↔auth hop uses the
  port-agnostic loopback client above.
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

`pnpm auth:mint` lives in the **repo root** package (`pnpm cli` lives in
`apps/os` — don't mix them up; pnpm's "command not found" error when you run
either from the wrong directory is unhelpful).

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

**Minted identities with no org claims dead-end in the browser.** OS routes
users with zero organizations to the auth worker's `/project-access` page,
where your forged JWT means nothing (auth wants its own session) — a headless
agent lands on a Google login and is stuck. `--admin` does not bypass this.
The working recipe to browse OS as a minted identity:

```bash
# 1. create a project via the operator path (admin API secret; from apps/os)
cd apps/os
doppler run --project os --config dev -- pnpm cli --base-url http://localhost:<port> \
  rpc projects create --slug my-proj      # → note the returned "id"

# 2. mint with BOTH org and project claims (the org can be any made-up id —
#    OS authorizes from claims; only auth-worker round-trips reject fakes)
doppler run --project os --config dev -- pnpm auth:mint --email agent+test@nustom.com \
  --orgs '[{"id":"org_x","slug":"x","name":"X","role":"admin"}]' \
  --projects '[{"id":"<id from step 1>","slug":"my-proj","organizationId":"org_x"}]' \
  --browser-url
# → opens straight onto /projects/my-proj
```

A signed-in _human_ never hits this: the real OAuth flow walks you through
creating an org + project on first sign-in (test emails `+...test@` with OTP
`424242` work for that flow too, fully headless).

The `browserSignInUrl` embeds the (short-lived) tokens as query params — treat
it as a secret: it can appear in browser history and edge request logs, so
don't paste it into shared channels.

### Minting in production

The same mechanism works against **production** — you can mint a real
`os.iterate.com` session as any user to poke around in prd:

```bash
doppler run --project os --config prd -- pnpm auth:mint --email someone@nustom.com --browser-url
# open the printed URL → signed in on https://os.iterate.com as that user
```

The forge key is a **master key**: anyone holding `AUTH_FORGE_PRIVATE_JWK`
from `os/prd` can mint a session as any user, including admins. There is no
audit trail yet — an audited mint endpoint on the auth worker is the planned
replacement. Until then, guard that Doppler value like any production secret
and prefer minting a scoped (non-admin) identity when you can.

Because the prd forge key is god-mode, the deploy refuses to bake its public
key into the worker unless you opt in explicitly: `os/prd` must carry **both**
`AUTH_FORGE_PRIVATE_JWK` and `AUTH_FORGE_ALLOW_PRODUCTION=true`. A forge key
that lands in a prod config without the flag fails the deploy loudly rather
than silently arming minting (each environment also uses its own key id —
`iterate-forge-dev`/`-preview`/`-prd` — so a leak is scoped to one
environment). Generate a fresh forge key with
`pnpm tsx scripts/auth/generate-forge-key.ts --kid iterate-forge-<env>`.

## Browsers: the golden path for agents

1. If your agent environment has a built-in browser (Cursor, Devin, …), use
   that.
2. Otherwise use **agent-browser against a dedicated headless Chrome** — never
   attach to the user's running Chrome unless they explicitly asked (the
   attach prompt requires human approval; an AFK user means you hang forever):

```bash
# one-time: agent-browser install
# pick ONE binary explicitly — the glob matches multiple installed versions
BIN=$(ls -d "$HOME/.agent-browser/browsers/"*"/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" | sort -V | tail -1)
PROFILE=$(mktemp -d /tmp/ab-XXXXXX)   # fresh profile per run — see below
nohup "$BIN" --headless=new --remote-debugging-port=9444 --user-data-dir="$PROFILE" about:blank >/dev/null 2>&1 & disown

AGENT_BROWSER_AUTO_CONNECT=0 agent-browser --cdp 9444 open "$(doppler run --project os --config dev -- pnpm --silent auth:mint --browser-url)"
AGENT_BROWSER_AUTO_CONNECT=0 agent-browser --cdp 9444 snapshot -i
```

(`AGENT_BROWSER_AUTO_CONNECT=0` matters: some machines default agent-browser
to auto-attaching to the user's real Chrome.) Run agent-browser commands
serially — concurrent invocations wedge its daemon.

**Identity hygiene**: cookies leak across runs from two directions — a reused
`--user-data-dir`, and agent-browser's own saved session state
(`~/.agent-browser/sessions/*.json`), which its daemon can re-inject even
into a fresh profile. If the browser shows a user you didn't mint, run
`agent-browser --cdp 9444 cookies clear` before signing in. When testing
auth flows specifically, always start with a fresh profile + `cookies clear`.

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
doppler run --project _shared --config prd -- pnpm preview status              # see what's free
doppler run --project _shared --config prd -- pnpm preview acquire --slot 9    # lease it (3h default)
# → prints leaseId + the matching release command

# 2. Deploy (same primitive as everything else; auth first — OS bakes its JWKS from it):
cd apps/auth && doppler run --project auth --config preview_9 -- pnpm alchemy:up
cd ../os     && doppler run --project os   --config preview_9 -- pnpm alchemy:up

# 3. Point a browser at it (same org-claims requirement as local dev — see
#    "Acting as users" above; bare --admin lands on the auth login page):
doppler run --project os --config preview_9 -- pnpm auth:mint --admin --browser-url

# 4. Tear down and release when done:
cd apps/os   && doppler run --project os   --config preview_9 -- pnpm alchemy:down
cd ../auth   && doppler run --project auth --config preview_9 -- pnpm alchemy:down
doppler run --project _shared --config prd -- pnpm preview release --slot 9 --lease-id <leaseId>
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
CAPTUN_TUNNEL_NAME=jonas pnpm dev     # https://jonas.tunnels.iterate.com
```

The captun Vite plugin (`apps/os/vite.config.ts`) activates when
`CAPTUN_TUNNEL_NAME` is set. Local dev also uses that name to derive
`APP_CONFIG_BASE_URL` (`https://<name>.tunnels.iterate.com`) unless
`APP_CONFIG.baseUrl` is set explicitly. The plugin forwards public HTTP and
WebSockets to your local dev server, so HMR and itx can use the same public
tunnel URL.

For personal `dev_<user>` configs, startup also ensures the shared dev auth
client accepts `https://<name>.tunnels.iterate.com/api/iterate-auth/callback`.
Shared `dev` does not mutate auth client state; use a personal dev config when
you need human OAuth through a tunnel. Tests open tunnels via
`createPublicTunnel` (`apps/os/e2e/test-support/create-test-project.ts`)
against the same gateway.

Tunnels are not scarce. The genuinely scarce thing is the webhook-source
configuration — a Slack app points at exactly one delivery URL at a time —
so set a stable `CAPTUN_TUNNEL_NAME` per person (held in `dev_<user>`) to keep
that URL working.

## Slack end-to-end testing

See [slack-smoke-testing.md](slack-smoke-testing.md). Slack requires public
HTTPS webhooks, so this runs against deployed environments or a local dev
server exposed through captun, not plain-localhost dev.
