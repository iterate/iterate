# Deployment topologies (2026-07-31)

The whole model is **two workers + one dynamic worker**, and every topology is the _same code_ with a
different config. This is the "maximum clear" map, with what's proven and what's next.

## The pieces (same everywhere)

| piece                                           | what it is                                                                                                              | changes per topology?                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **control plane worker** (`apps/control-plane`) | the front desk: login + session + **directory (D1/sqlfu)** + OAuth 2.1 AS + console + `/api` + `/mcp` + ingress routing | only its **config** (login mode, control-plane host) |
| **project worker** (`apps/project-worker`)      | the runner: loads + serves a project's confined config worker (Worker Loader). NO directory, NO auth.                   | can move to a **separate CF account**                |
| **project config worker**                       | the per-project **dynamic** worker the project worker loads (the project's own app/code)                                | it's user code                                       |

**The dial (control plane → project worker)** has two transports, one behavior:

- **same account** → a service binding: `env.RUNNER.serve(request, projectId, app, caller)`.
- **cross account** → HTTP: `POST /serve` with a shared secret + `x-iterate-*` headers. Service bindings
  don't cross Cloudflare accounts, so this is what makes topology 4 real. Both proven; the HTTP path is
  deployed and tested (`scripts/prove-twoworker.mjs`).

(`apps/kernel` was the prior _monolithic_ prototype — one worker doing everything. control-plane +
project-worker are the realized two-worker split; the kernel remains as the reference the split was carved
from, its `directory.ts`/`routing.ts`/`auth-wall.ts` now superseded by the control plane's D1 directory.)

The **one human-auth knob** is `LOGIN_MODE` on the control plane worker (proven, all three):

- `email` — the login form takes an email, we own the session. _(self-host / consumer)_
- `access` — read the verified email from a Cloudflare-Access header. _(hosted / bounded team)_
- `open` — no login, a single anonymous identity. _(the Raspberry-Pi floor)_

The directory (users/orgs/projects/memberships/routes/api_keys) **always** lives in the control plane
worker's D1 — it does not vary by topology. OAuth AS + `/mcp` + CIMD are always present; they simply go
unused in a pure wide-open box.

## The four topologies

### 1. Self-host — one account, one domain ✅ PROVEN (deployed)

The reference deployment. Control plane at a reserved host (`iterate.<domain>`), projects at
`<slug>.<domain>`; both workers in the user's own CF account. `LOGIN_MODE=email`.

- **Proven** on `https://control-plane.iterate.workers.dev`: `scripts/prove.mjs` → **13/13**, incl. the full
  MCP OAuth dance with **CIMD** (self-describing `client_id` URL, no DCR), **org+project created at
  `/authorize`**, token scoped to it, and the API-key→`/mcp` path.

### 2. Hosted — multi-tenant (iterate.com) ◐ substrate proven

Same two workers, same account, but `LOGIN_MODE=access` (Cloudflare Access fronts the control-plane host
and injects the verified email) and a real reserved control-plane host. Many orgs/projects/users.

- **Proven**: `LOGIN_MODE=access` resolves identity from `cf-access-authenticated-user-email` (and refuses
  when the header is absent). The directory/OAuth/MCP substrate is the same one proven in (1).
- **Not yet**: a real Access-fronted deploy + the project worker serving project hosts.

### 3. Wide-open — the Raspberry-Pi floor ◐ browser proven

`LOGIN_MODE=open`: no login, every caller is `user_anonymous`, first-class. Zero config, runs anywhere.

- **Proven**: `GET /` with no login → "Signed in as anonymous"; the console works without auth.
- **Open item**: in this mode `/mcp` should be **tokenless** (the Pi has no OAuth). Today `/mcp` is always
  an OAuth-protected apiRoute, so it still challenges. Wiring "open ⇒ `/mcp` needs no token" is a small,
  named TODO (design §Open-questions).

### 4. Separate account — project worker elsewhere ○ think-through (needs the project worker)

The project worker (execution) deployed to a **different Cloudflare account** from the control plane — the
"run projects in a separate account" case. Cloudflare **service bindings do not cross accounts**, so the
control plane can't RPC the runner directly; the dial becomes **HTTP + a shared credential** (the born
project API key / a signed control-plane token the runner verifies). The control plane stays the single
directory + auth authority; it resolves the caller, then dials the remote runner over HTTPS with a
capability token scoped to the project. Same `dialRunner(ctx)` chokepoint, HTTP transport instead of a
binding.

- **Not yet**: depends on Phase 6 (extract the project worker + its dial). Then prove a cross-account dial.

## Proof status at a glance

| topology               | login            | MCP (CIMD)   | org+project @authorize | API key | project execution                         |
| ---------------------- | ---------------- | ------------ | ---------------------- | ------- | ----------------------------------------- |
| 1 self-host one-domain | ✅ email         | ✅ deployed  | ✅                     | ✅      | ✅ deployed (control plane→runner)        |
| 2 hosted (Access)      | ✅ access-header | ✅ (same AS) | ✅ (same AS)           | ✅      | ✅ (same dial)                            |
| 3 wide-open            | ✅ open/anon     | ✅ tokenless | n/a                    | ✅      | ✅ (same dial)                            |
| 4 separate account     | ✅ (any mode)    | ✅ (same AS) | ✅                     | ✅      | ✅ HTTP dial proven (cross-account shape) |

Proofs (all deployed): `prove.mjs` 13/13 (login/OAuth/CIMD/MCP/org+project@authorize/API key),
`prove-api.mjs` 4/4 (capnweb /api), `prove-twoworker.mjs` 7/7 (host→project resolve → HTTP dial →
confined config worker). 24 assertions, green on live workers.dev.

## What's left (follow-ups, not blockers)

The two-worker split is realized and proven. Remaining polish:

1. **Fold the kernel's fuller capabilities into the project worker** — the config worker's ITX currently
   exposes only `whoami`; the kernel's `ProjectCapabilities` (streams/secrets/ai) + the two-level egress
   door are already proven there and drop in behind the same `ProjectEntrypoint`.
2. **Real project-host ingress** — today the control plane fronts project hosts via `/__ingress?host=`;
   with a wildcard route / custom domains it fronts `<slug>.<base>` directly (same `resolveHost`+dial).
3. **Same-account transport** — swap the HTTP dial for the `env.RUNNER` service binding when co-located
   (`ProjectRunner.serve` is already written; it's a binding config, not a code change).
4. **Console: use `/api` + routes UI** — the console's project/route management can move onto the capnweb
   `/api` instead of bespoke form POSTs.
5. **`itx.auth.fetch`** — userspace app auth as a capability (design §11).
