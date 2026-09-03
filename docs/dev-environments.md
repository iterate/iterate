# Dev environments

How local development, preview environments, and identities work.

## The core model (read this much at minimum)

Every deployed environment is an entry in the root **`envs.ts`** (hostnames,
worker names, accounts, resource IDs) plus a Doppler config of the same name
carrying its secrets. `pnpm run deploy --env prd` deploys production,
`--env preview_N` a preview slot; `dev` runs a fully-local server and never
deploys. Scripts never branch on environment names; envs.ts + the config
supply everything.

Local dev is **fully local**: D1/DOs run in miniflare inside your worktree's
`.wrangler/`, the server listens on a random free port at
`http://localhost:<port>`, and the only external dependency is the shared dev auth at
`https://auth.iterate-dev.com`. OS is a single worker (all Durable Object
classes + app + api in one script, see `apps/os/docs/worker-topology.md`)
running inside vite's workerd — production-shaped by construction. Nothing
is contested between worktrees: twenty
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
  `.wrangler/` state, and human sign-in through `auth.iterate-dev.com`.
  Personal `dev_<you>` configs may still carry personal integration secrets,
  but they should not carry app/MCP/project-host URL overrides.

  Don't add old flat auth OAuth/JWKS vars in these configs. Auth signs JWTs
  with `AUTH_FORGE_ES256_PRIVATE_JWK`; local and deployed relying parties derive its
  public JWKS locally from the same Doppler value. Doppler
  `APP_CONFIG_ITERATE_AUTH__JWKS` snapshots should be absent: generated config
  and deploy scripts own that derived binding, so a manually pinned copy can
  only drift.

- The chosen port is recorded in **`apps/os/.dev-server/dev-server.json`**
  (`{pid, port, baseUrl, startedAt}`).
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
  **`apps/os/.dev-server/dev-server.log`**. Tail it from another terminal with
  `tail -f apps/os/.dev-server/dev-server.log` from the repo root, or
  `tail -f .dev-server/dev-server.log` from `apps/os`.
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
    BASE=$(node -p "require(\"./.dev-server/dev-server.json\").baseUrl")
    npx -y @modelcontextprotocol/inspector --cli "$BASE/api/mcp" \
      --transport http \
      --method tools/list \
      --header "Authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET"
  '
  ```

  If `tools/list` works, call the smallest harmless tool invocation:

  ```bash
  doppler run --project os --config dev -- sh -lc '
    BASE=$(node -p "require(\"./.dev-server/dev-server.json\").baseUrl")
    npx -y @modelcontextprotocol/inspector --cli "$BASE/api/mcp" \
      --transport http \
      --method tools/call \
      --tool-name exec_typescript \
      --tool-arg project=<project-slug> \
      --tool-arg "code=async (itx) => { return await itx.__describe(); }" \
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
- Test emails: outside production, any `nustom.com` address ending its local
  part with `+test` (e.g. `alice+test@nustom.com`) gets the fixed OTP `424242`
  and sends no real email. This is controlled by
  `APP_CONFIG_FIXED_TEST_OTP_ENABLED`; production sets it false and always sends
  a real email OTP.
- One-click login links: on fixed-test-OTP deployments, auth's `/test-login`
  endpoint signs a test address in server-side (no typing at all), ensures the
  user has an org + project, and redirects into the relying party's OAuth flow:

  ```
  https://auth.<env-host>/test-login?email=pr<N>%2Btest%40nustom.com&project=pr<N>&return_to=https://os.<env-host>/api/iterate-auth/login
  ```

  `project` (optional) names the org and first project; it defaults to the
  email local part minus `+test`. `return_to` may be a same-origin path or a
  registered relying party URL (the deployment's seeded OAuth clients).
  Preview PR comments render this as the `Login ↗` link, and the preview
  deploy visits it once so the `pr<N>` user + project already exist by the
  time anyone clicks. It grants nothing the fixed OTP doesn't already grant;
  production 404s the route (`apps/auth/src/server/test-login.ts`).

- Template-carrying login links: a single URL can preselect the test user AND
  the project to create — maximally useful in PR bodies:

  ```
  https://os.<env-host>/api/iterate-auth/login?login_hint=pr<N>%2Btest%40nustom.com&project_hint=pr<N>-template-<name>
  ```

  `login_hint` (an email) prefills sign-in ("Continue as …", fixed OTP as
  above). `project_hint` (a project slug) rides the OAuth flow the same way
  and prefills the first-run project slug instead of the derived-from-email
  suggestion. The slug convention does the rest on the OS side: a slug ending
  `-template-<name>` makes `create()` use `configs/<name>` from
  `github:iterate/iterate` as the project's config template, and a slug
  prefix starting `pr<N>` pins the ref to `pull/<N>/head` — so a
  config-template PR can link to a project born from its own in-flight
  template, and `pr<N>-<anything>-template-<name>` gives everyone their own
  collision-free slug for the same template. A template folder GitHub
  definitively reports absent (404) creates the project stock; a
  rate-limited or unreachable GitHub records the template anyway, so a
  quota'd birth fails visibly instead of silently going stock. Hints are
  suggestions only: the user still confirms every step (the hint also names
  the first-run organization, keeping test signups collision-free), and
  explicit `configRepoTemplate` arguments always win over the convention.

The dev-global auth deploys from `main` (alongside prd auth) and reseeds its
OAuth clients from Doppler on every deploy — see
`apps/auth/scripts/seed-oauth-clients.ts`.

Working on the auth app itself? Run it locally
(`pnpm --dir apps/auth dev`) and point OS at it by overriding
`APP_CONFIG_ITERATE_AUTH__ISSUER` (e.g. `http://localhost:7101/api/auth`) in
your env or Doppler branch config. A local OS process may use a known preview
or shared-dev auth deployment through a remote service binding. Production is
blocked by default because that binding carries write authority; explicitly set
`ALLOW_REMOTE_PRODUCTION_AUTH_RPC=1` only when you intend local code to call
`auth-prd`. The coordinated production workflow sets the same guard while it
generates the complete Wrangler config. For a manual production OS deployment,
use:

```bash
ALLOW_REMOTE_PRODUCTION_AUTH_RPC=1 pnpm run deploy --env prd
```

Preview CI deploys every selected app concurrently. Auth and its relying
parties use the same Doppler-owned signing key, so JWT verification creates no
deployment dependency. Production uses the coordinated `Deploy Auth + OS`
workflow; the dedicated auth workflow deploys only `auth-dev-global`.

## Acting as users and admins

For product administration and support, prefer the OS operator-session
mechanism. It needs only the selected environment's admin secret and opens a
browser with a synthetic operator principal confined to one resolved project.
It does not impersonate a customer or inherit that customer's other projects:

```bash
cd apps/os
doppler run --config preview_3 -- pnpm cli session create \
  --project my-project --open
doppler run --config prd -- pnpm cli session create \
  --project customer-project --open
doppler run --config prd -- pnpm cli session create --admin --open
```

The first two commands can access only their selected project; `--admin` is a
separate platform-wide mode. See
[Operator Sessions](../apps/os/docs/operator-sessions.md) for the E2E-created
preview project workflow, production support workflow, API contract, and
security model. The forge-key flow below remains useful in non-production when
testing the real OAuth-session shape, arbitrary organization claims, or auth UI
behavior.

Auth signs JWTs with one Doppler-owned ES256 (P-256) key. OS and the other relying
workers trust only its public half, derived locally during config generation or
deploy from `AUTH_FORGE_ES256_PRIVATE_JWK` (inherited from `_shared/dev` /
`_shared/preview` / `_shared/prd`). The same private key powers offline
identity minting, so minting is instant and does not call the auth worker:

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
   Playwriter, and pasting into a real browser. This is THE way to point a
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
  --eval 'const project = await itx.projects.get("my-proj").create({}); return await project.__describe()' # note the returned projectId
)

# 2. mint with BOTH org and project claims (the org can be any made-up id —
#    OS authorizes from claims; only auth-worker round-trips reject fakes)
doppler run --project os --config dev -- pnpm auth:mint --email agent+test@nustom.com \
  --orgs '[{"id":"org_x","slug":"x","name":"X","role":"admin"}]' \
  --projects '[{"id":"<id from step 1>","slug":"my-proj","organizationId":"org_x"}]' \
  --browser-url
# → opens straight onto /projects/my-proj
```

**`pnpm getin` automates this whole recipe for local dev**: it finds (or
detached-starts) the worktree's dev server, gets-or-creates the `test` project,
mints `test+test@nustom.com` with matching claims, and opens the sign-in URL in
your browser. `pnpm getin -w [name]` runs it against another worktree
(bare `-w` lists them, most recently touched first); `--print` prints the URL
instead of opening it.

A signed-in _human_ never hits this: the real OAuth flow walks you through
creating an org + project on first sign-in (`+test@nustom.com` test emails with
OTP `424242` work for that flow too outside production, fully headless).

The `browserSignInUrl` embeds the (short-lived) tokens as query params — treat
it as a secret: it can appear in browser history and edge request logs, so
don't paste it into shared channels.

### Playwright specs against local dev or previews

The root Playwright config has projects named `web` and `mobile`. `pnpm spec`
runs both; use `pnpm spec --project=web` or `pnpm spec --project=mobile` to
select one product surface. Playwright owns both server lifecycles: it preserves
the existing OS start/reuse behavior and launches a per-run Expo Web server on
a free loopback port for the mobile specs.

Web specs use the same forge key and admin API secret, but mint the
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
`APP_CONFIG_ITERATE_AUTH__ISSUER`, and `AUTH_FORGE_ES256_PRIVATE_JWK` for JWT
minting. Those values are expected to come from the same `os` Doppler config as
the worker under test. The access-token resource is derived from the target OS
base URL (`http://localhost` for loopback local dev, otherwise the normalized
base URL). The helper validates `process.env` first, then falls back to
`doppler secrets download --no-file --format json` from `apps/os` when those
values are missing; it never infers auth values from redirects.
`APP_CONFIG_BASE_URL` is the only target override; when it is unset, Playwright
runs the OS dev script through Node with `start`, `--detach`, `--keep-alive`,
and `--port <port>`, so it reuses the same per-worktree dev server recorded in
`apps/os/.dev-server/dev-server.json`, then waits directly on that server's
`/api/health`.

The mobile project always targets its local Expo Web server, including when the
web project targets a deployed preview. Its phone-sized browser specs and
reviewed baselines live under `specs/mobile/`.

### Minting in production

The same mechanism works against **production** — you can mint a real
`os.iterate.com` session as any user to poke around in prd:

```bash
doppler run --project os --config prd -- pnpm auth:mint --email someone@nustom.com --browser-url
# open the printed URL → signed in on https://os.iterate.com as that user
```

The forge key is a **master key**: anyone holding `AUTH_FORGE_ES256_PRIVATE_JWK`
from `os/prd` can mint a session as any user, including admins. There is no
audit trail yet — an audited mint endpoint on the auth worker is the planned
replacement. Until then, guard that Doppler value like any production secret
and prefer minting a scoped (non-admin) identity when you can.

Because the prd signing key is god-mode, Auth and relying-party deploys refuse
to use it unless you opt in explicitly: their prd Doppler configs must resolve
both `AUTH_FORGE_ES256_PRIVATE_JWK` and `AUTH_FORGE_ALLOW_PRODUCTION=true`. A key
that lands in a prod config without the flag fails the deploy loudly rather
than silently arming Auth signing and offline minting (each environment also
uses its own key id — `iterate-forge-dev`/`-preview`/`-prd` — so a leak is
scoped to one environment). Generate a fresh forge key with
`pnpm tsx scripts/auth/generate-forge-key.ts --kid iterate-forge-<env>`.

## Browsers: the golden path for agents

See [Browser testing](browser-testing.md) for the isolated, visible Chrome for
Testing default; unique concurrent-agent windows; explicit headless operation;
reusable test logins; and the permission required before attaching to a
developer's actual Chrome.

## Preview environments

To expand the fleet rather than use an existing slot, see
[Adding preview slots](adding-preview-slots.md).

Each preview slot N is a complete, isolated stack on the dev/preview
Cloudflare account: `os.iterate-preview-N.com`, `auth.iterate-preview-N.com`,
and `<proj-slug>.iterate-preview-N.app`. There are currently nineteen
`preview-<n>` slots, leased via semaphore (`environment-config-lease`).

### The lease model: one slot per PR, for the PR's whole life

A slot belongs to whoever holds its semaphore lease, and every lease records
a **holder** (`pr-1234` for the PR flow, `manual-<user>` for humans). The
invariants:

- **A PR keeps its slot from first deploy until the PR closes.** Every
  `preview deploy` / `preview test` run renews the lease for 3h; closing the
  PR tears the apps down and releases it. Lease expiry is the safety valve for
  abandoned PRs (no pushes for >3h) — kept short because a leased slot costs us
  for its Cloudflare resources, and a deploy/e2e cycle is only minutes so an
  active PR never lapses mid-run. A lapsed lease is reclaimed by the scheduled
  GC sweep — see **[Preview resource GC](preview-resource-gc.md)** for how
  teardown is decoupled from releasing the slot (and how disposable data
  expires 3h after last use).
- **A slot is only populated while a run is in progress.** `preview deploy`
  erases the slot's data (Durable Objects, D1, KV, Artifacts repos —
  `erase-data`) before every deploy, not just when the slot changes hands,
  and CI runs `preview erase` again after the e2e. Each run otherwise leaves a
  population of test projects whose Durable Objects keep waking until the
  next push or the lease expiry (~$15–25/hour per slot; the 2026-09-01
  runaway), and a push that cancels a running e2e SIGKILLs it, so in-test
  cleanup can never be the guarantee — the before-deploy erase is. A
  cancelled job runs none of its `always()` steps on Depot, so a cancelled
  run's population waits for the next run's before-deploy erase; the
  after-run erase also skips itself if it ever runs after the PR head moved
  on (that push's run erases before it deploys). Consequence: manual QA state on a preview
  does not survive a push or an e2e run — the login link in the PR body
  mints a fresh test user and project on demand.
- **The semaphore is the single source of lease truth.** The PR body's
  managed section only _displays_ the slot (and per-app results); it is never
  consulted for ownership and never a reason to skip. Before running tests or
  destroying anything, the tooling asks the semaphore which slot the PR holds
  right now, and refuses (with an explanation naming the current holder) if
  the answer is "not that one". So a stale PR's cleanup can never destroy
  another PR's preview, e2e never runs against someone else's deployment, and
  nothing steals a live lease without a human `--force`.
- **Contention queues instead of exploding.** When all nineteen slots are leased,
  `preview deploy` waits in line (logging who holds what every few minutes)
  for up to 6 minutes before failing with the full holder table and
  remediation steps. `PREVIEW_SLOT_WAIT_MS=0` makes it fail fast.
- **Freed slots rest as long as possible.** Acquiring "any slot" hands out
  the least-recently-released one (never-used slots first). A freed slot
  often still carries its previous holder's deployment, so resting it
  maximizes the chance a lapsed PR retakes its own slot instead of finding
  someone else on it.
- **Everything is attributable and visible.** `pnpm preview status` shows
  each slot's holder, PR open/closed state, idle/orphaned verdict, open
  PRs without a slot, and reclaim commands when the fleet
  is full for a reason other than "nineteen open PRs". The semaphore UI at
  semaphore.iterate.com shows the same live leases; every lease transition
  (acquired/renewed/evicted/expired/force-released) is logged as an event in
  the coordinator. Exceptional states — waiting for a slot, no slot
  available, slot taken over, slot moved — are additionally bannered as a
  caution alert at the top of the PR body's managed preview section.

  ```bash
  # Why are there no free slots? (uses GITHUB_TOKEN or `gh auth token`)
  doppler run --project _shared --config prd -- pnpm preview status
  # Free an orphaned/idle slot after checking no cleanup is mid-flight:
  pnpm preview reclaim --slot preview-4 --force
  # Reclaim every slot whose lease has expired (what the hourly GC cron runs;
  # --dry-run to preview). Never touches a live lease.
  doppler run --project _shared --config prd -- pnpm preview gc --dry-run
  ```

A PR can request one configured slot by putting an exact standalone
line in its body:

```text
preview_environment=preview-17
```

If the requested slot is unknown or held by another owner, acquisition fails
without forcing the holder or silently falling back to another slot.

CI and local machines run the **same preview commands against the same
semaphore**. CI additionally checks the deployment epoch before invoking those
commands.

The preview CI deployment-epoch check rejects branches from before the
OS-to-auth Workers RPC migration before any app is touched. Rebase onto current
`main` when that check fails; there is no compatibility deployment path. A
direct deploy from an old checkout cannot be protected by code that checkout
does not contain and is unsupported. Doppler/Cloudflare deploy access is an
operator capability, so use current `main` for manual preview deployments.

### Story 1: CI previews my PR

Opening/pushing a PR that touches preview-relevant paths triggers the
`Cloudflare Previews` workflow, which runs `pnpm preview run` — deploy then
e2e as one step, sharing one resolved PR head so a push cannot race into a
gap between them. The PR body's managed "Environment Config Lease" section
records the slot, per-app URLs and statuses; the workflow logs narrate every
decision (which apps were selected and why, lease transitions, slot waits).
Diff selection may reuse an unchanged app's exact recorded Worker deployment,
but never its test result: every triggered PR head reruns every recorded app's
e2e suite, and a run with no runnable deployment fails instead of reporting a
green `deploy + e2e` check.
Closing or merging the PR runs `pnpm preview cleanup`, which destroys the
PR's apps (for os that means erasing the slot's data — auth D1 and
project-directory KV) and releases the slot — after verifying the PR still
holds it.

Slot cleanliness is an **invariant of entry**, not a promise about exits:
every handover — a fresh acquire, an adopted lease, a reclaim, an
`assign`ed slot — erases the slot's data before the new holder gets it. So
even when an exit path skips the cleanup erase (failed cleanup followed by
lease expiry, `release --force`, a run cancelled mid-claim), the next tenant
never sees the previous one's data; they just pay the ~half-minute wipe on
their first deploy to that slot. The one deliberate exception is manual
`preview acquire` (Story 4): it parks a slot without wiping it, so you can
lease a slot precisely to inspect what's on it.

### Story 2: run what CI runs, locally

```bash
# same lifecycle as CI for PR 1234 (deploy + e2e, one step — wraps `pnpm preview run`):
doppler run --project _shared --config prd -- pnpm preview:ci 1234

# or the phases individually (flake hunting deploys once, then loops `test`):
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- pnpm preview run --pull-request-number 1234
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- pnpm preview deploy --pull-request-number 1234
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- pnpm preview test --pull-request-number 1234
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- pnpm preview cleanup --pull-request-number 1234
```

These share the PR's slot and PR-body state with CI (ownership lives in the
semaphore), so a local run renews (never fights) the slot CI claimed for the
same PR.

For a focused flake hunt, reuse the exact OS deployment and run one test file
repeatedly without deploying, erasing the slot, or changing the PR's recorded
full-suite result:

```bash
# Vitest target paths are relative to apps/os.
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- \
  pnpm preview test-target --pull-request-number 1234 --runner vitest \
  --target e2e/vitest/itx-agents.e2e.test.ts \
  --grep "Agent scripts can send web-chat messages" --repeat 25

# Playwright target paths are relative to the repository root.
GITHUB_TOKEN="$(gh auth token)" doppler run --project _shared --config prd --preserve-env=GITHUB_TOKEN -- \
  pnpm preview test-target --pull-request-number 1234 --runner playwright \
  --target specs/repo-ide.spec.ts --grep "discarding a new file" --repeat 25
```

Each repeat is a fresh runner invocation against the same immutable Worker
versions and has CI's single test-level retry enabled. Absorbed retries remain
visible in the per-run output and final summary. All requested samples run so
the summary preserves the failure rate, then the command exits nonzero if any
sample failed. The PR must still own its slot and OS plus its test dependencies
must be recorded at the PR's current head; otherwise the command refuses and
tells you to deploy first.

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

# Deploy concurrently; both derive the same signing key from Doppler:
(cd apps/auth && pnpm run deploy --env preview_9) &
(cd apps/os   && pnpm run deploy --env preview_9) &
wait

# Point a browser at it (same org-claims requirement as local dev — see
# "Acting as users" above; bare --admin lands on the auth login page):
doppler run --project os --config preview_9 -- pnpm auth:mint --admin --browser-url

# Release when done. Workers/routes/DNS stay deployed — releasing a slot is
# just giving the lease back. You don't need to erase: the slot's next
# holder erases on entry. Do it yourself only if the data shouldn't linger:
(cd apps/os && pnpm erase-data --env preview_9)  # optional
doppler run --project _shared --config prd -- pnpm preview release --slot 9 --lease-id <leaseId>
```

Deploying to `preview_N` **without** holding the lease bypasses the whole
protection model — the slot's rightful holder will deploy over you, and their
cleanup may destroy your worker.

### Story 5: all slots are taken / something is stuck

`pnpm preview reclaim` is the conflict-resolution tool. It classifies every
leased slot by how its holder is actually behaving:

- **orphaned** — the holder is `pr-N` and that PR is closed. Its cleanup may
  still be running or may have failed; check the lifecycle run before taking
  it.
- **idle** — the holder hasn't deployed or tested for a while (default 6h;
  `--min-idle-hours N` tunes it). Leases renew on every deploy/test run, so
  idle really means "untouched". Probably safe; the report shows the holder
  and PR link so you can check.
- **active** — recently used. Taking it clobbers live work.

```bash
doppler run --project _shared --config prd -- pnpm preview status     # holders, PR links, expiries
doppler run --project _shared --config prd -- pnpm preview reclaim    # verdict per slot + reclaim commands
doppler run --project _shared --config prd -- pnpm preview reclaim --slot 4 --force  # after checking lifecycle runs
doppler run --project _shared --config prd -- pnpm preview reconcile  # leases vs Doppler configs vs Cloudflare zones
```

`reclaim --slot --force` takes the slot under a temporary lease of its own,
**erases its data**, then returns it to the pool clean — the previous holder's
projects, agents and schedules are gone, which is the point. If the erase
fails, the temporary lease stays in place (the slot shows as held by
`reclaim-<you>`) rather than a dirty slot going back in the pool.

Automation never force-reclaims a live lease, including one whose PR is
closed. That lets close-triggered cleanup remain the sole owner until it has
finished erasing and releases the slot; another PR can queue but cannot deploy
or erase concurrently. A failed cleanup leaves the lease visible until it
expires or an operator verifies the lifecycle is stopped and runs the explicit
`reclaim --slot N --force` path.

`--force` (on `acquire`, `release`, and `reclaim`) is the only way to take any
live lease from its holder. Every eviction logs an
`evicted`/`force-released` event with both identities, so the audit trail
survives.

### Slot plumbing (OAuth constants)

The slot's OS↔auth OAuth client credentials are **constants in Doppler**
(`auth/preview_N` carries `AUTH_SEED_OAUTH_CLIENTS`; `os/preview_N` carries
the matching `APP_CONFIG_ITERATE_AUTH__*`). Every auth deploy reseeds them
into its database, so the DB can never drift from Doppler and the two apps
need no deploy-time coordination. Provisioning/rotation:
`doppler run --project _shared --config prd -- pnpm preview provision-auth-preview-configs --rotate`.

JWT signing is independent of `APP_CONFIG_BETTER_AUTH_SECRET`: the Better Auth
JWT adapter reads the fixed `AUTH_FORGE_ES256_PRIVATE_JWK` from Doppler and does not
store generated signing keys in D1. Rotating the Better Auth secret therefore
needs no JWKS cleanup.

More detail on the semaphore primitive:
[devops-cloudflare-doppler.md](devops-cloudflare-doppler.md).

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
