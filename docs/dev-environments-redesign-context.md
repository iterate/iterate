# Dev environments redesign — working context doc

Status: **working draft** (grilling session 2026-06-11). Nothing implemented yet. Captures the
problem, decisions, user stories, trade-offs, and remaining recommendations-pending-confirm.

## Problem statement

1. **Parallel agents collide.** Many AI agents work on one machine in separate worktrees, but
   default dev shares contested resources: one cloudflared tunnel name, a dev OAuth client
   whose secret is **rotated on every `alchemy.run.ts` run** (`ensureLocalDevOAuthClient` →
   `ensureClient` rotates any referenceId containing `:dev_`), fixed ports (auth hardcodes
   7101, OS defaults 5173), per-user dev domains.
2. **Local dev requires too much infrastructure.** Default dev should be fully local
   (miniflare D1/DOs, localhost, auto-picked port) with minimal external dependencies.
3. **Agent-facing runbooks are missing or scattered**: admin session in prod, impersonation,
   Slack e2e — and especially **browsers**. Instructions for driving browsers are spread
   across home-directory and project-directory agent configs (agent-browser, a chrome-cdp MCP
   with auto-attach, …) and they conflict. The golden path must be: agents use **their own
   headless browser** almost always; attaching to the user's running Chrome (to reuse their
   session or see what they see) is a rare exception done **only when the user explicitly
   asks** — because the attach prompt requires human approval, and an AFK user means a stuck
   agent.
4. **Dev and preview are conceptually the same thing** — what differs is which contested
   resources they hold. This should be explicit, not implicit in Doppler config naming.

## The contested-resources model

An environment is `alchemy.run.ts` run in the context of a Doppler config (the sacred
primitive — prd config deploys prd, dev config runs local, no branching on names). Everything
painful is one of a small set of **contested resources**:

| Resource                                                                                                                           | Why needed                                                                                                                                          | Contested?                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public ingress (tunnel)                                                                                                            | Inbound webhooks (Slack, GitHub, …)                                                                                                                 | **No** — self-hosted captun server mints arbitrary caller-named tunnels at `<name>.tunnels.iterate.com` in ~200ms; unbounded                                                            |
| Wildcard SSL + CNAME (`*.iterate-preview-N.app` …)                                                                                 | Project slugs are routable: `<proj-slug>.<base>`                                                                                                    | Per preview slot; in dev, captun catch-all eventually covers it                                                                                                                         |
| **Webhook-source / third-party app configuration** (a Slack app pointed at a specific tunnel URL, OAuth callback registrations, …) | An external app binds to exactly one delivery/callback URL at a time (Slack additionally requires HTTPS redirects — never worked on bare localhost) | **Yes — the genuinely, permanently scarce thing.** The tunnel isn't scarce; the _configuration of the webhook source_ is. One app ↔ one URL ⇒ naturally per-human, held in `dev_<user>` |
| Iterate-auth OAuth clients                                                                                                         | OS needs a registered client                                                                                                                        | No — shared loopback constant (dev) / Doppler-seeded constants (preview)                                                                                                                |

Preview slots (`preview_1..9`, semaphore-leased) are a bundle of these. Tunnels do NOT become
semaphore resources — they're not scarce; only webhook-source configuration is.

## Decisions

Global rule (applies to every item below): **no backwards compatibility anywhere** — clean
breaking changes, single-PR cutovers, no legacy bridges or compat shims; non-prd environments
can be destroyed and recreated.

### Local dev

1. **Default `pnpm dev` = apps/os only, fully local, zero Cloudflare resources.**
   Miniflare-backed D1/DOs in the worktree's `.alchemy`, no tunnel, no per-user domain.
   Worktree isolation makes parallel agents safe by construction.
2. **Port: alchemy picks a free random port and bakes `base_url` as an env var** (get-port
   style, replacing Vite auto-increment). Request-sniffing the base URL was rejected: cron and
   scheduled work start without request context.
3. **Localhost subdomain convention, plain HTTP:** `os.localhost:<port>`,
   `<proj-slug>.os.localhost:<port>`, `auth.localhost:<other-port>`. Browsers resolve
   `*.localhost` to loopback and treat it as a secure context — no certs, no /etc/hosts.
   Caveat: curl/Node on macOS don't resolve `*.localhost` — use `--resolve`, a Host header
   against `127.0.0.1:<port>`, or plain `localhost:<port>`. Code: slug resolution already
   strips ports (`apps/os/src/lib/project-host-routing.ts`); only URL generation
   (`buildProjectWorkerUrl`, hardcoded `https://` + portless base) needs origin-style bases.
   3a. **One dev server per worktree (invariant) + discovery file.** Exactly one running dev
   server is allowed per git worktree. On boot, the alchemy script writes a discovery file in
   the worktree (e.g. `.alchemy/dev-server.json`: `{pid, port, baseUrl, startedAt}`); on a
   second `pnpm dev` it refuses (or offers takeover) if the recorded pid is alive; stale
   files are cleaned automatically. CLIs and scripts that target "the local dev server"
   resolve the base URL from this file by default — no guessing which random port, no
   `--base-url` ceremony. This is the localhost analogue of "the Doppler config knows the
   base URL".
4. **The external dependency is the dev-global auth: `auth.iterate-dev.com`** on the
   dev/preview Cloudflare account. Every merge to `main` deploys prd auth AND the dev-global
   auth. Humans sign in there (Google/OTP) with real identities — once per browser profile,
   valid across all worktrees/envs. Agents never need it (see minting).
5. **One shared, permanent "local dev" OAuth client** in the dev-global auth whose redirect
   validation accepts any localhost port (RFC 8252-style loopback matching, gated to this one
   client). `ensureLocalDevOAuthClient` and its rotation churn die.
6. **Auth-on-localhost is opt-in via config, not orchestration:** working on auth = your
   branch config (or one-off env) overrides `APP_CONFIG_AUTH__ISSUER` to
   `http://auth.localhost:<port>/api/auth` and you run auth yourself. A convenience script
   (`pnpm dev:with-auth`, successor to `dev-all`) starts auth then OS pointed at it. Auth's
   hardcoded port 7101 moves to the same pick-free-port scheme.
7. **Env var cleanup + rename:** the legacy alias layer (`ITERATE_OAUTH_ISSUER`,
   `ITERATE_OAUTH_CLIENT_ID/SECRET`, `ITERATE_AUTH_JWKS`, `ITERATE_AUTH_SERVICE_TOKEN`,
   mapped in `apps/os/alchemy.run.ts:21-74`) dies, and the surviving family is renamed
   `APP_CONFIG_ITERATE_AUTH__*` → **`APP_CONFIG_AUTH__*`** (config key `auth.*`). The
   deploy-time JWKS fetch stays (genuine deployment logic; in dev/preview the trusted JWKS is
   the union of issuer keys + forge pubkey).

### Doppler hierarchy

8. **Runnable root `dev` config + thin per-user branch diffs.** Three native layers (all in
   use today): `_shared/dev` (cross-project Config Inheritance) → app root `dev` →
   `dev_<user>` branch configs (live-inherit root, override individual values). Root `dev`
   becomes **complete and runnable**: any agent runs `doppler run --config dev -- pnpm dev`
   with zero provisioning. Branch configs contain exactly two things: (a) personally-held
   contested resources (per-user Slack app, stable captun hostname), (b) momentary
   experiments (env vars tried on a branch before graduating to root `dev`). Humans default
   to their branch config; agents default to root `dev` unless handed a branch config for
   third-party-OAuth/webhook work (inherently serialized by the third party anyway — no
   "60 Slack apps" problem).

### Preview

9. **Preview always deploys auth, per slot — clean controlled slate for e2e:**
   `os.iterate-preview-N.com` + `auth.iterate-preview-N.com` + `<proj>.iterate-preview-N.app`.
10. **OAuth client credentials are constants in Doppler; the seed enforces Doppler → auth DB**
    on every deploy (idempotent, declarative upsert of id + secret + redirect URIs).
    Consequences: auth and OS deploy **concurrently**; every deploy stays reproducible as
    plain `doppler run --config X -- tsx alchemy.run.ts`; drift impossible (Doppler is the
    single source of truth; nothing else may rewrite clients — the `:dev_` rotation logic
    dies). Pipeline-minting was rejected: right only for arbitrary-cardinality envs; if those
    arrive, the semaphore _lease provisioner_ mints creds into a Doppler config at
    lease-creation time, keeping deploys parallel and pure.
    10a. **Preview orchestration lives in repo-root `scripts/` as oRPC handlers, runnable in any
    Doppler config context.** The scripts that coordinate a preview rollout — deploy
    sequencing, seeding, health checks — are normal doppler-backed scripts (same mechanism as
    `apps/os`'s `pnpm cli`, lifted to the repo root since they span apps). Invariant:
    **whatever CI does is exactly reproducible locally** by running the same script under the
    same Doppler config; CI workflows are thin wrappers with no logic of their own.

### Identity, admin, impersonation

11. **Identity = minted issuer-signed JWTs, everywhere (dev/preview/prd).** OS verifies JWTs
    against a baked JWKS and is deliberately ignorant of auth's user table — identities exist
    the moment a trusted JWT asserts them (org/project access is already claims-driven). No
    OAuth dance, no seeded test users, no OTP for OS testing. Auth gains a token-exchange
    endpoint: given the env's service token (machines) or a platform-admin session (humans,
    better-auth `ADMIN_ALLOWLIST`), returns a JWT with arbitrary `sub`/`email`/claims, an
    `act` (actor, RFC 8693) claim recording the minter, audit logging, short default TTL.
    OS gains `GET /api/auth/session-from-token?token=…` → normal session cookie + redirect —
    one-URL sign-in for Playwright/agent-browser/humans (replaces the OAuth dance in tests;
    much faster).
12. **Per-environment signer: forge offline in dev/preview, audited endpoint in prd.** A
    **forge keypair** is a constant in `_shared/dev` (separate one in `_shared/preview`):
    pubkey appended to the env's trusted JWKS, private key in every script's env via Doppler.
    `mintAdminJwt()` / `pnpm cli auth mint`: private key present → local jose sign (~1ms, no
    network, no auth worker running **or deployed** — fully-local/offline dev works); absent
    (prd) → call auth's mint endpoint with the service token (audited, `act`, short TTL,
    cached until expiry). **Hard placement rule: forge keys never appear in any prd config.**
    Prd break-glass needs no standing credential: prd auth Doppler access holders can sign
    with the issuer key directly if auth is hard-down.
    _Update: the prd hard-rule was relaxed — `os/prd` now carries a forge key behind an
    explicit `AUTH_FORGE_ALLOW_PRODUCTION=true` opt-in, so the same offline `pnpm auth:mint`
    works against production. It's an unaudited master key for now; the audited auth-worker
    endpoint above is still the intended end state. See `docs/dev-environments.md`._
13. **One trust root; the parallel admin systems die** (one cutover PR, no compat bridges):
    `APP_CONFIG_ADMIN_API_SECRET` (admin = JWT with `platformAdmin` claim), the
    `iterate-admin-auth` cookie bridge (→ session-from-token), `X-Iterate-As-User` (→ mint
    with `act`), the bootstrap admin user whose password is the service token. Per
    environment: exactly one standing machine credential (auth `SERVICE_AUTH_TOKEN`) and one
    human gate (platform-admin session, allowlisted). better-auth admin plugin remains only
    as the human gate + OAuth client management UI. Migration is cheap: the admin secret is
    injected centrally (CLI header construction, e2e env helpers, admin cookie command) —
    those few points switch to `mintAdminJwt()`; call sites unchanged.
14. **CLI surface: `pnpm cli auth mint`** — an oRPC-handler script in **repo-root `scripts/`**
    (same home as preview orchestration, decision 10a — minting spans apps, so it's
    repo-level, not `apps/os`); Doppler config picks the environment. Not the `iterate` CLI.
15. **ITX integration: explicitly deferred — do NOT build now.** Recorded as future direction
    only: auth stays the signer; ITX could expose `itx.auth.mintSession(...)` on the global
    handle returning a handle-for-that-principal with `.jwt()` / `.browserSignInUrl()` export
    formats. Revisit after the minting cutover has landed and proven itself.

### Tunnels

16. **Self-hosted captun server; cloudflared ripped out entirely.** A captun server deployed
    independently of the OS worker, with its own captun secret (in Doppler), serving
    `<name>.tunnels.iterate.com` — caller picks the name, tunnel up in ~200ms, WebSockets
    supported via our capnweb fork. Documented for humans and agents: configure the captun
    CLI against our server with the Doppler secret to get a named tunnel; use it for any
    environment that needs to receive webhooks. Also usable **programmatically** — no
    shelling out.
    16a. **captun Vite plugin (lives in the captun package).** A Vite plugin that opens a named
    tunnel to the running dev server in-process. `pnpm dev` with tunneling enabled =
    the plugin dials `<name>.tunnels.iterate.com`; no cloudflared binary, no alchemy Tunnel
    resource, no DNS provisioning per dev. (Assume this plugin exists for planning purposes;
    building it is part of the captun workstream, superseding parts of
    `tasks/switch-dev-tunnels-to-captun.md`.)
17. **Tunnel doc** explains the only reasons to reach for one: inbound webhooks, and
    third-party OAuth flows needing an HTTPS callback — plus the reminder that the scarce
    thing is the webhook-source configuration, not the tunnel.

## User stories (the redesign, concretely)

1. **Agent does product work in a fresh worktree.** `doppler run --config dev -- pnpm dev` →
   OS at `http://os.localhost:51234`, miniflare state local to the worktree. Needs to be a
   user? Forges a JWT with the dev forge key (offline, ~1ms), opens
   `session-from-token?token=…` in headless agent-browser, clicks around as that user. Needs
   admin oRPC? Same forge with `platformAdmin: true`. Twenty sibling agents do the same
   simultaneously; nothing is shared but CPU.
2. **Human does product work.** Same, but `--config dev_jonas` (branch diff) and you sign in
   once with Google via `auth.iterate-dev.com`; your identity works in every env on your
   machine.
3. **Human tests Slack flows.** `dev_jonas` carries your personal Slack app + stable captun
   hostname; `pnpm dev` + captun named tunnel; Slack events arrive at the tunnel; smoke-test
   per `docs/slack-smoke-testing.md`. Inherently one-at-a-time per Slack app — that's the
   third party's constraint, not ours.
4. **Human works on auth itself.** Branch config sets
   `APP_CONFIG_AUTH__ISSUER=http://auth.localhost:<port>/api/auth`; run
   `pnpm dev:with-auth` (or two terminals). Deploy-time JWKS fetch retries while auth boots.
5. **Debugging prd as a specific user.** `doppler run --config prd -- pnpm cli auth mint
--sub usr_x --browser-url` → audited mint with `act: jonas`, paste URL, you're them.
   This _is_ the impersonation mechanism; `X-Iterate-As-User` is gone.
6. **Preview e2e in CI.** Slot leased → auth + OS deploy concurrently from `preview_N`
   config → seed enforces OAuth clients from Doppler → tests forge JWTs with the preview
   forge key (no OAuth dance → Playwright suites get much faster).
7. **Agent needs inbound webhooks (rare).** Enable the captun Vite plugin (or call captun
   programmatically) to get `<worktree-name>.tunnels.iterate.com`; no lease, no contention;
   tears down with the dev server. The scarce step, if any, is pointing a webhook source
   (e.g. a Slack app) at that URL — which is the human's per-user resource.
8. **CLI/script talks to "the" local dev server.** Reads `.alchemy/dev-server.json` in the
   worktree (one-dev-server-per-worktree invariant) and gets the live base URL/port — no
   flags, no guessing.

## Trade-offs accepted

- **Human sign-in in local dev depends on a deployed service** (`auth.iterate-dev.com`).
  Mitigated: agents and tests never depend on it (offline forge); auth developers run auth
  locally anyway.
- **Dev/preview JWTs are forgeable by anyone with the Doppler dev scope** — i.e. dev/preview
  have no meaningful authn audit. Deliberate: that's what dev means here; prd minting is
  audited and forge-key-free.
- **`*.localhost` doesn't resolve in curl/Node on macOS** — CLI flows use `localhost:<port>`
  or Host-header tricks; only browsers get pretty subdomains.
- **A breaking auth change on main lands on `auth.iterate-dev.com` (and next preview
  deploys) before dependent OS PRs merge** — fix-forward, dev-only blast radius.
- **The admin-secret cutover touches every e2e fixture and the itx browser tests in one PR**
  — accepted per no-backcompat preference; injection is centralized so the diff is small.
- **Killing per-user domains/tunnel-by-default** means anything that silently relied on a
  public dev URL (existing Slack subscriptions, OAuth callbacks registered to
  `iterate-dev-<user>.com`) needs explicit migration to the captun hostname.

## Remaining recommendations (pending confirm — annotate!)

A. **Docs layout.** Replace scattered guidance with: `docs/dev-environments.md` (the
three-paragraph core model + user stories above), `docs/tunnels-and-webhooks.md` (when you
need public ingress, captun usage, third-party OAuth callback story),
`docs/acting-as-users-and-admins.md` (minting runbook: dev forge, prd exchange,
impersonation, browser sign-in URLs, ITX capability), keep `docs/slack-smoke-testing.md`.
AGENTS.md gets a short "how do I…" index linking all four. `headless-local-debugging.md`
and `preview-agent-browser-smoke.md` get folded in/rewritten.
B. **Browser golden path (decided direction, wording to land in docs):** one canonical doc
replacing the conflicting browser instructions scattered across home- and project-level
agent configs. The decision tree:

1.  If your agent environment ships a better built-in browser (e.g. Cursor's or Devin's
    built-in browser), use that.
2.  Otherwise use **agent-browser** (headless) — the standard we consolidate on for now,
    because it's one easy-to-describe tool; revisit later.
3.  Driving the user's running Chrome (chrome-devtools MCP auto-attach) is allowed **only
    when the user explicitly asked for it** — it reuses their session / shows their tabs,
    and it triggers an approval popup that hangs unattended agents. The doc includes the
    golden-path instructions for this case too, so when it _is_ requested it's done right.
    Sign-in for any of these: the minted `session-from-token` URL.
    C. **Kill list (same PR or fast-follow):** `dev-all` script, `dev_localhost` config,
    `ensureLocalDevOAuthClient` + `sync-auth-clients.ts` (superseded by seed + loopback
    client), `ITERATE_OAUTH_*`/`ITERATE_AUTH_*` aliases (and the
    `APP_CONFIG_ITERATE_AUTH__*` → `APP_CONFIG_AUTH__*` rename), **cloudflared entirely**
    (alchemy `Tunnel` resource, `start-cloudflared.ts`, wildcard DNS provisioning), per-user
    `iterate-dev-<user>.com` domains (→ `<name>.tunnels.iterate.com`; coordinate with the
    pending domain-account moves), OTP-424242 test-user machinery _for OS tests_ (auth's own
    tests may keep it).
    D. **Implementation order (proposal):** (1) minting + JWKS-union + admin-secret cutover —
    highest leverage, no infra moves; (2) root `dev` config runnable + localhost/random-port
    dev + dev-server discovery file + loopback client; (3) preview auth per slot + seed +
    repo-root orchestration scripts; (4) self-hosted captun server + Vite plugin + tunnel doc;
    (5) docs pass incl. browser golden path (can land with 1).

## Useful current-state facts (verified 2026-06-11)

- Root `pnpm dev` already runs only OS; `pnpm dev-all` is the auth+OS shell one-liner (root
  `package.json:6`) using the `ITERATE_OAUTH_ISSUER` alias + `--preserve-env`.
- Auth vite port 7101 hardcoded in `apps/auth/alchemy.run.ts:121`; OS defaults 5173.
- Preview today does **not** deploy auth; preview OS uses prd auth (issuer default in
  `apps/os/src/config.ts:71`).
- Auth: better-auth on D1; bootstrap admin `admin@nustom.com` (password = `SERVICE_AUTH_TOKEN`)
  seeded via `apps/auth/scripts/render-admin-seed.ts`; OTP `424242` for `/\+.*test@/i` in dev
  configs; `X-Iterate-As-User` + `X-Iterate-Service-Token` minting synthetic 1-hour sessions
  (`apps/auth/src/server/utils/hono.ts`); session table has `impersonatedBy` (better-auth
  admin plugin).
- OS admin: `Authorization: Bearer $APP_CONFIG_ADMIN_API_SECRET` (`apps/os/src/auth/admin.ts`);
  browser e2e via `iterate-admin-auth` cookie (`apps/os/src/itx/admin-auth-cookie.ts`); OS
  holds `iterateAuth.serviceToken` in config.
- OS bakes JWKS at deploy (`apps/os/alchemy.run.ts:31-63`), falls back to runtime fetch;
  loopback issuers skip Doppler-provided JWKS.
- Preview slots leased via semaphore (`scripts/preview/preview.ts`,
  `preview-inventory.ts`); destroy+recreate per push already happens.
- Existing docs to fold in: `docs/slack-smoke-testing.md`,
  `apps/os/docs/headless-local-debugging.md`, `apps/os/docs/preview-agent-browser-smoke.md`,
  `docs/devops-cloudflare-doppler-alchemy-setup.md`.
- Doppler refs: [Branch Configs](https://docs.doppler.com/docs/branch-configs),
  [Config Inheritance](https://docs.doppler.com/docs/config-inheritance). Verify during
  implementation: `_shared` Config Inheritance values flowing through to branch configs
  (works today empirically).
