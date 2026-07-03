# Dev environments

How local development, preview environments, and identities work.

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

- **Config selection**: `pnpm dev` preserves an existing `doppler run`
  environment; otherwise it loads Doppler secrets from the `apps/os` local setup
  into the spawned dev server. For a one-off config, use
  `doppler run --project os --config dev_<you> -- pnpm dev`; do not set
  `DOPPLER_CONFIG` by hand.
- **Which config?** `dev`, `dev_jonas`, `dev_misha`, and `dev_rahul` all run
  the same fully-local OS server: random localhost port, per-worktree
  `.alchemy/` state, and human sign-in through `auth.iterate-dev.com`.
  Personal `dev_<you>` configs may still carry personal integration secrets,
  but they should not carry app/MCP/project-host URL overrides.

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
  flags, no guessing. `pnpm dev` runs `apps/os/scripts/dev.ts`; extra args
  forward, so `pnpm dev status`, `pnpm dev attach`, and
  `pnpm dev restart --detach` use the same local lifecycle module. A second
  start attaches to the existing
  live server; use `restart` to replace it. The file appears ~10–15s before
  the port actually accepts connections (Vite is still booting) — poll the
  base URL until it returns a response before driving it.
- Dev server output is mirrored to the gitignored
  **`apps/os/.alchemy/dev-server.log`**. Tail it from another terminal with
  `tail -f apps/os/.alchemy/dev-server.log` from the repo root, or
  `tail -f .alchemy/dev-server.log` from `apps/os`.
- Project hosts work in the browser as `<proj-slug>.localhost:<port>`.
  Browser project ingress uses `*.localhost`; curl/Node on macOS usually do
  not resolve those names, so non-browser clients should use
  `localhost:<port>` with a Host header.
- Local MCP is the normal OS app route:
  `http://localhost:<port>/api/mcp`. Do not use `mcp.localhost` for local
  scripts unless you have configured local wildcard DNS yourself.
  Smoke it with the MCP Inspector from `apps/os`:

  ```bash
  doppler run --project os --config dev -- sh -lc '
    BASE=$(node -p "require(\"./.alchemy/dev-server.json\").baseUrl")
    npx -y @modelcontextprotocol/inspector --cli "$BASE/api/mcp" \
      --transport http \
      --method tools/list \
      --header "Authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET"
  '
  ```

  If `tools/list` works, call the smallest harmless tool invocation:

  ```bash
  doppler run --project os --config dev -- sh -lc '
    BASE=$(node -p "require(\"./.alchemy/dev-server.json\").baseUrl")
    npx -y @modelcontextprotocol/inspector --cli "$BASE/api/mcp" \
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
# 1. create a project via the operator path (admin API secret)
(cd apps/os && doppler run --project os --config dev -- pnpm cli itx run \
  --base-url http://localhost:<port> \
  --eval 'const p = await itx.projects.create({ slug: "my-proj" }); return await p.describe()' # note the returned projectId
)

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

### Playwright specs against local dev or previews

Root Playwright specs use the same forge key and admin API secret, but mint the
session cookie directly instead of going through the browser sign-in URL. If
`apps/os` has a Doppler config selected, `pnpm spec` can read the needed secrets
directly; wrap the command in `doppler run` when you want to force a particular
config:

```bash
# local dev: starts or reuses the local OS dev server when APP_CONFIG_BASE_URL is unset
pnpm spec

# same thing, forcing a specific Doppler config
doppler run --project os --config dev -- pnpm spec

# deployed preview: the Doppler config supplies APP_CONFIG_BASE_URL for the OS worker
doppler run --project os --config preview_3 -- pnpm spec

# arbitrary deployed OS worker: preserve an explicit APP_CONFIG_BASE_URL override
APP_CONFIG_BASE_URL=https://os-preview-3.iterate.com \
  doppler run --project os --config preview_3 --preserve-env=APP_CONFIG_BASE_URL -- pnpm spec
```

Forged-session specs validate one env contract: `APP_CONFIG_ADMIN_API_SECRET`
for project fixture setup, plus `APP_CONFIG_ITERATE_AUTH__CLIENT_ID`,
`APP_CONFIG_ITERATE_AUTH__ISSUER`, and `AUTH_FORGE_PRIVATE_JWK` for JWT
minting. Those values are expected to come from the same `os` Doppler config as
the worker under test. The access-token resource is derived from the target OS
base URL (`http://localhost` for loopback local dev, otherwise the normalized
base URL). The helper validates `process.env` first, then falls back to
`doppler secrets download --no-file --format json` from `apps/os` when those
values are missing; it never infers auth values from redirects.
`APP_CONFIG_BASE_URL` is the only target override; when it is unset, Playwright
runs the OS dev script through Node with `start`, `--detach`, `--keep-alive`,
and `--port <port>`, so it reuses the same per-worktree dev server recorded in
`apps/os/.alchemy/dev-server.json`, then waits directly on that server's
`/api/health`.

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
and `<proj-slug>.iterate-preview-N.app`. There are nine slots
(`preview-1..9`), leased via semaphore (`environment-config-lease`).

### The lease model: one slot per PR, for the PR's whole life

A slot belongs to whoever holds its semaphore lease, and every lease records
a **holder** (`pr-1234` for the PR flow, `manual-<user>` for humans). The
invariants:

- **A PR keeps its slot from first deploy until the PR closes.** Every
  `preview deploy` / `preview test` run renews the lease for 24h; closing the
  PR tears the apps down and releases it. Lease expiry is only the safety
  valve for abandoned PRs (no pushes for >24h).
- **Nothing steals a live lease without a human `--force`.** Before running
  tests or destroying anything, the tooling re-asserts that the PR still
  holds the slot, and refuses (with an explanation naming the current holder)
  if it doesn't. So a stale PR's cleanup can never destroy another PR's
  preview, and e2e never runs against someone else's deployment.
- **Contention queues instead of exploding.** When all nine slots are leased,
  `preview deploy` waits in line (logging who holds what every few minutes)
  for up to 20 minutes before failing with the full holder table and
  remediation steps. `PREVIEW_SLOT_WAIT_MS=0` makes it fail fast.
- **Freed slots rest as long as possible.** Acquiring "any slot" hands out
  the least-recently-released one (never-used slots first). A freed slot
  often still carries its previous holder's deployment, so resting it
  maximizes the chance a lapsed PR retakes its own slot instead of finding
  someone else on it.
- **Everything is attributable and visible.** `pnpm preview status` shows
  each slot's holder, PR link, and expiry; the semaphore UI at
  semaphore.iterate.com shows the same; every lease transition
  (acquired/renewed/evicted/expired/force-released) is logged as an event in
  the coordinator. Exceptional states — waiting for a slot, no slot
  available, slot taken over, slot moved — are additionally bannered as a
  caution alert at the top of the PR body's managed preview section.

CI and local machines run the **same commands against the same semaphore** —
there is no CI-only path.

### Story 1: CI previews my PR

Opening/pushing a PR that touches preview-relevant paths triggers the
`Cloudflare Previews` workflow, which runs `pnpm preview deploy` then
`pnpm preview test`. The PR body's managed "Environment Config Lease" section
records the slot, per-app URLs and statuses; the workflow logs narrate every
decision (which apps were selected and why, lease transitions, slot waits).
Closing or merging the PR runs `pnpm preview cleanup`, which destroys the
PR's apps and releases the slot — after verifying the PR still holds it.

### Story 2: run what CI runs, locally

```bash
# same lifecycle as CI for PR 1234 (deploy + test):
doppler run --project _shared --config prd -- pnpm preview:ci 1234

# or the individual steps CI runs:
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- pnpm preview deploy --pull-request-number 1234
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- pnpm preview test --pull-request-number 1234
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- pnpm preview cleanup --pull-request-number 1234
```

These share the PR's lease and PR-body state with CI, so a local run renews
(never fights) the slot CI claimed for the same PR.

### Story 3: pin a PR to a slot

`preview assign` says "this PR shall have this slot" (or whatever is free)
and records it in the PR body's managed section, so the next deploy — CI or
local — lands there:

```bash
# give PR 1234 whatever slot is free (fails fast with the holder table if none):
doppler run --project _shared --config prd -- pnpm preview assign --pull-request-number 1234

# pin PR 1234 to preview-3 specifically:
doppler run --project _shared --config prd -- pnpm preview assign --pull-request-number 1234 --slot 3
```

If the PR already holds a satisfying slot, assign just renews it. Moving to a
different slot releases the old lease and marks the PR's deployed apps for
redeploy (the next `preview deploy` re-lands them on the new slot). If the
requested slot is leased, assign names the holder and refuses without
`--force`. A GitHub token comes from `GITHUB_TOKEN` or a logged-in `gh` CLI.

### Story 4: a manual slot for experiments

Lease a slot under your own name first — that is what stops PR previews from
deploying over you and PR cleanups from destroying your work:

```bash
doppler run --project _shared --config prd -- pnpm preview status              # who holds what
doppler run --project _shared --config prd -- pnpm preview acquire --slot 9    # lease it (3h default, --hours N)
# → prints leaseId + the matching release command
# if preview-9 is taken you'll be told who holds it; --force evicts them (their
# deployment gets clobbered by whatever you deploy next — only for stale holds)

# Deploy (same primitive as everything else; auth first because OS bakes its JWKS):
(cd apps/auth && doppler run --project auth --config preview_9 -- pnpm alchemy:up)
(cd apps/os   && doppler run --project os   --config preview_9 -- pnpm run deploy)

# Point a browser at it (same org-claims requirement as local dev — see
# "Acting as users" above; bare --admin lands on the auth login page):
doppler run --project os --config preview_9 -- pnpm auth:mint --admin --browser-url

# Tear down and release when done:
(cd apps/os   && doppler run --project os   --config preview_9 -- pnpm run destroy)
(cd apps/auth && doppler run --project auth --config preview_9 -- pnpm alchemy:down)
doppler run --project _shared --config prd -- pnpm preview release --slot 9 --lease-id <leaseId>
```

Deploying to `preview_N` **without** holding the lease bypasses the whole
protection model — the slot's rightful holder will deploy over you, and their
cleanup may destroy your worker.

### Story 5: all slots are taken / something is stuck

`pnpm preview reclaim` is the conflict-resolution tool. It classifies every
leased slot by how its holder is actually behaving:

- **orphaned** — the holder is `pr-N` and that PR is closed, so its cleanup
  failed; the holder can never come back for the slot. Safe to take.
- **idle** — the holder hasn't deployed or tested for a while (default 6h;
  `--min-idle-hours N` tunes it). Leases renew on every deploy/test run, so
  idle really means "untouched". Probably safe; the report shows the holder
  and PR link so you can check.
- **active** — recently used. Taking it clobbers live work; `reclaim` refuses
  without `--force`.

```bash
doppler run --project _shared --config prd -- pnpm preview status     # holders, PR links, expiries
doppler run --project _shared --config prd -- pnpm preview reclaim    # verdict per slot + what's safe to take
doppler run --project _shared --config prd -- pnpm preview reclaim --slot 4   # take back an orphaned/idle slot
doppler run --project _shared --config prd -- pnpm preview reconcile  # leases vs Doppler configs vs Cloudflare zones
```

Orphaned leases are also garbage-collected automatically: when `preview
deploy` finds every slot taken, it checks each `pr-N` holder against GitHub
and reclaims a slot whose PR is closed before queueing. That is the **only**
case automation takes a live lease — idle-but-open and manual holds always
need a human running `reclaim --slot` / `--force`.

`--force` (on `acquire`, `release`, and `reclaim`) is the only way to take an
actively-used lease from its holder. Every eviction logs an
`evicted`/`force-released` event with both identities, so the audit trail
survives.

### Slot plumbing (OAuth constants)

The slot's OS↔auth OAuth client credentials are **constants in Doppler**
(`auth/preview_N` carries `AUTH_SEED_OAUTH_CLIENTS`; `os/preview_N` carries
the matching `APP_CONFIG_ITERATE_AUTH__*`). Every auth deploy reseeds them
into its database, so the DB can never drift from Doppler and the two apps
need no deploy-time coordination. Provisioning/rotation:
`doppler run --project _shared --config prd -- pnpm preview provision-auth-preview-configs --rotate`.

More detail on the semaphore primitive:
[devops-cloudflare-doppler-alchemy-setup.md](devops-cloudflare-doppler-alchemy-setup.md).

## Tunnels and webhooks

Inbound webhooks (Slack, GitHub) and third-party OAuth callbacks need a
public HTTPS hostname — that's the only reason to add a public local URL to
fully-local dev.

The **iterate public local gateway** (`apps/tunnels`, deployed at
`tunnels.iterate.com`) mints public local URLs on demand: any caller dials it
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
URL.

For personal `dev_<user>` configs, startup also ensures the shared dev auth
client accepts `https://<name>.tunnels.iterate.com/api/iterate-auth/callback`.
Shared `dev` does not mutate auth client state; use a personal dev config when
you need human OAuth through a public local URL. Tests that need public local
URLs use the same gateway.

Public local URLs are not scarce. The genuinely scarce thing is the webhook-source
configuration — a Slack app points at exactly one delivery URL at a time —
so set a stable `CAPTUN_TUNNEL_NAME` per person (held in `dev_<user>`) to keep
that URL working.

## Slack end-to-end testing

See [slack-testing.md](slack-testing.md). Slack requires public HTTPS webhooks,
so this runs against deployed environments or a local dev server exposed
through captun, not plain-localhost dev. The older
[slack-smoke-testing.md](slack-smoke-testing.md) note is retained for the
historical manual production smoke path.
