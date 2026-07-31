# Deployment topologies (2026-07-31)

The whole model is **two workers + one dynamic worker**, and every topology is the _same code_ with a
different config. This is the "maximum clear" map, with what's proven and what's next.

## The pieces (same everywhere)

| piece                                           | what it is                                                                                            | changes per topology?                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **control plane worker** (`apps/control-plane`) | the front desk: login + session + **directory (D1/sqlfu)** + OAuth 2.1 AS + console + `/api` + `/mcp` | only its **config** (login mode, control-plane host) |
| **project worker** (`apps/kernel` → renaming)   | the runner: hostname→project routing + executes project code (Worker Loader)                          | can move to a **separate CF account**                |
| **project config worker**                       | the per-project **dynamic** worker the project worker loads (the project's own app/code)              | it's user code                                       |

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

| topology               | login            | MCP (CIMD)       | org+project @authorize | API key | project execution              |
| ---------------------- | ---------------- | ---------------- | ---------------------- | ------- | ------------------------------ |
| 1 self-host one-domain | ✅ email         | ✅ deployed      | ✅                     | ✅      | ⧗ Phase 6                      |
| 2 hosted (Access)      | ✅ access-header | ✅ (same AS)     | ✅ (same AS)           | ✅      | ⧗ Phase 6                      |
| 3 wide-open            | ✅ open/anon     | ◐ tokenless TODO | n/a                    | ✅      | ⧗ Phase 6                      |
| 4 separate account     | ✅ (any mode)    | ✅ (same AS)     | ✅                     | ✅      | ○ cross-account dial (Phase 6) |

## What's left (Phase 6)

1. Move the capnweb `Os` `/api` root + console off the project worker into the control plane; point
   `Os.authenticate()`'s `resolveCaller` at the D1 directory; delete the kernel's `directory.ts`/`routing.ts`.
2. Strip `apps/kernel` to the **project worker** (routing + runner) and deploy it alongside the control
   plane; prove hostname→project routing + `/api` + project execution.
3. Wire "wide-open ⇒ `/mcp` tokenless".
4. The separate-account HTTP dial + a cross-account proof.
