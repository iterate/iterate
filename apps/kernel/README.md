# kernel — clean-room iterate, pure-play

A from-scratch, minimal rebuild of the iterate model (design:
`../os/docs/simplification/clean-room-build.md`). Backend-only, pure-play (**the kernel has no
Node compat**), no dependency on `apps/os`. Deployed and running on the prd Cloudflare account.

**What this honestly is:** a **confinement + identity skeleton**. It proves per-project
confinement, pluggable/optional identity, and one intercepted egress door — and is explicit about
what it does _not_ yet build (egress policy, the durable log, secrets).
Both are catalogued, with fixes, in the two-reviewer audit:
[`../os/docs/simplification/kernel-review-2026-07-28.md`](../os/docs/simplification/kernel-review-2026-07-28.md).

## Wide open, or behind a wall

The kernel does **no login of its own**. `APP_CONFIG` has **two independent, optional authorities**;
identity has exactly two shapes (see [`src/wall.ts`](src/wall.ts)):

**`wall` — _who authenticated you._**

| mode                    | config                                            | who authenticates                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **wide open** (default) | no `wall`                                         | nobody — users don't exist / don't matter. Run it bare behind Caddy / a Tunnel, or open.                                                                                            |
| **behind a wall**       | a `wall` `{ header, jwksUrl, issuer, audience? }` | something on ingress (Cloudflare Access, an auth.iterate.com forward-auth proxy, …) authenticated the human and injected a signed JWT on a header; the kernel just **verifies** it. |

Cloudflare Access and auth.iterate.com are the **same** to the kernel — different `WallConfig`s (a
header + a JWKS + issuer/audience). No OIDC, cookies, PKCE, or DCR in the kernel; that all lives in the
wall, where it belongs.

**`directory` — _which projects exist + who's a member._** Enforced at `/api` on `projects.get(id)`.

| mode                 | `directory.provider`  | membership + creation                                                           |
| -------------------- | --------------------- | ------------------------------------------------------------------------------- |
| **open** (default)   | `open` (or unset)     | every project reachable by anyone; a project exists the moment you name it      |
| **local**            | `local` + `projects`  | a fixed, read-only set (create refused)                                         |
| **kv**               | `kv` + `DIRECTORY_KV` | a **local persistent registry** — create/enumerate in a KV namespace, no auth   |
| **auth.iterate.com** | `auth.iterate.com`    | the **real auth worker's directory** over a same-account `AUTH` Service binding |

`session.projects.create({name})` births a project through whichever directory is configured — **the
same call works in both modes**. Hosted (`auth.iterate.com`) writes it to `auth-prd`
(`createProjectForOrganization`, under the org in your token); self-host (`kv`) writes it to a local
KV namespace with no auth worker at all. Reads go the same way: `auth.iterate.com` calls
`getProjectBySlug` for existence and `listProjectsForUser` for membership (keyed on the token `sub`).
The dependency stays a clean DAG — **`kernel → auth`, and auth NEVER calls the kernel** (auth owns the
directory it's the source of truth for; the kernel reads/writes through it, but auth never reaches
back up). That one-way edge is what keeps it acyclic. Finer-grained authorization stays userspace.

## Live deployments (prd account)

|             | **hosted**                                 | **self-hosted**                                  |
| ----------- | ------------------------------------------ | ------------------------------------------------ |
| worker      | `kernel`                                   | `kernel-selfhost`                                |
| projects at | `<slug>.templestein.iterate2.app`          | `<slug>.shiterate.com`                           |
| identity    | **wall**: auth.iterate.com JWT (proxy TBD) | **wall**: Cloudflare Access (team `iterate-com`) |
| directory   | **auth.iterate.com** (`AUTH` → `auth-prd`) | **kv** (local KV registry, no auth)              |

**Same worker code — hosted vs self-hosted is `APP_CONFIG`, not a fork.** The caller is the **verified
wall JWT** (or empty, wide open), carried raw; past the door only non-secret identity is published
(`published()` strips the raw signed token — the one cheap, correct boundary, identity's version of
"don't hand the sandbox raw bindings"). A wall JWT yields `{format:"jwt", issuer:"<the wall>"}`; wide
open yields `{credentials:[]}`. We deliberately **do not carry the user's raw access token / run OIDC** —
that machinery (login, callback, cookies, `azp` dances) lived in the kernel and caused every auth
headache; it belongs in the wall. Orgs reach create as an **explicit `organizationSlug`** (the
security-relevant input); auto-org-from-token can return later via a proper "your orgs" lookup.

## The request flow (one worker)

`fetch` router on every request: **hostname → { projectId, app }** → verify the wall JWT (if a wall is
configured) → the **Worker Loader** runs a confined config worker, handed one props-scoped
`ProjectEntrypoint` as _both_ `env.ITX` (capabilities) and `globalOutbound` (the one egress door). The
kernel owns exactly one path before the config worker:

- **`/api`** — the capability tree over **capnweb** (WebSocket + HTTP batch), the OS front desk,
  mirroring apps/os exactly: `Os.authenticate(credentials?)` → `Session` → `session.projects.get(project)`
  → a `Project` handle (an unknown slug is a **prospective** handle whose `create({ organizationSlug? })`
  births it; `project.projectId` resolves once granted). `projects.get` is the membership gate. The
  default caller is the **ambient wall JWT**; the one explicit lane is `project-app-session`.

## Multiple apps by hostname + selective Cloudflare Access

Apps are addressed by **hostname**, like apps/os (`resolveIngress`): `<slug>.<hostBase>` is the
project's **default** app; **`<app>--<slug>.<hostBase>`** selects a named app (a single label, so the
`*.<hostBase>` wildcard + cert cover it, and each app sits at its own hostname root — no base path).
The kernel stamps `x-iterate-app`; the **config worker** (`{ fetch, processEvent }`) serves the right
app: the default is a **public website**, `dashboard` is the OS dashboard (a proxied vessel, or an
inline page). Confinement is real — the config worker sees only `["ITX","OS_DASHBOARD_ORIGIN"]`.

This is how a self-host is **Cloudflare-Access-protected yet keeps public routes**: Access is scoped
at the edge to the app hostname — `dashboard--*.shiterate.com` demands a login, while
`<slug>.shiterate.com` stays fully public. No kernel change: it verifies the Access JWT when present
(protected app → identified caller) and is anonymous otherwise (public app). Proven live:

```
demo.shiterate.com/            -> 200   public website (no login)
dashboard--demo.shiterate.com/ -> 302   Cloudflare Access login
```

## Right token for the layer — mint a narrow one for apps

A project **app** must never hold the user's session/token — it's the user's key to all of auth, wildly
over-privileged for one project. So the front door **mints a `project-app-session`** — a narrow,
15-minute, project-scoped HS256 grant (`mintProjectAppSession`, verified locally, mirroring apps/os) —
and hands _that_ to the app. The app acts as the user, scoped to one project, holding nothing replayable
upstream. The `/api` door then takes that lane: `authenticate({ type: "project-app-session", token })`,
and `projects.get(itsProject)` is honored without a directory hop (membership was checked at mint).
Proven live: a stamped app on a project the caller can reach reports `appSession: "present"` at
`/__debug`; the public app and anonymous callers get none.

(An earlier cut also **carried the user's raw access token** through the kernel — for act-as-user
later. A live login showed the cost: it's too big for a cookie, needs an `azp`/issuer dance, and buys a
capability we don't use yet — so it was dropped as premature. `published()` stays; carrying a real token
waits until act-as-user is actually built, done right with a server-side session.)

## The OS dashboard (`mini-apps/os`) — the `dashboard` app, a separately-deployed vessel

A full-stack **TanStack Start** app deployed standalone to `kernel-mini-os.iterate.workers.dev`,
served as the **`dashboard` app** at `dashboard--<slug>.<hostBase>` (its own hostname root, so its
assets need no base path). It **never holds the user's session** — the front door strips it and hands
the vessel a **narrow `project-app-session`** instead.

- **itx context at SSR** — a server function reads the non-secret caller the front door stamped, plus
  the minted `project-app-session` (the token is _used_ to call `/api`, never displayed).
- **a live capnweb `/api` dial from the client** — a same-origin WebSocket
  (`newWebSocketRpcSession(…/api)`, browser → project → kernel): `os.authenticate({ type:
"project-app-session", token })`, then `session.projects.get(thisSlug).projectId` — the app acting as
  the user, scoped to this project, with the narrow token. With no session it dials `os.authenticate()`
  (the ambient wall JWT, or anonymous): on hosted (directory → real `auth-prd`) that returns
  `caller:{credentials:[]}` and `projects.get("alice")` is **`denied: no such project 'alice'`** — the
  kernel called `auth-prd`'s `getProjectBySlug`, which returned null. A clean "no such project" (not
  "directory unavailable", not an error) proves the live RPC round-tripped to production auth.

## Identity + directory

- `src/wall.ts` — the **whole** of identity: verify the JWT the ingress wall injected on a header,
  against its JWKS (issuer + optional audience). Cloudflare Access and an auth.iterate.com forward-auth
  proxy are the same code, different `WallConfig`. No wall ⇒ wide open. **~47 lines — replaced a
  164-line OIDC client + a separate Access verifier.**
- `src/project-app-session.ts` — mint/verify the narrow, project-scoped app token (HS256, local verify,
  mirroring apps/os). The front door mints it; the `project-app-session` `/api` lane verifies it.
- `src/directory.ts` — the **directory authority** (which projects exist, membership, and creation),
  separate from identity. `open` / `local` / `kv` / `auth.iterate.com`. Unit-tested
  (`directory.test.ts`: auth provider driven by a mock, kv by a Map); the kernel reads/writes it but
  auth never calls back, so the dependency stays `kernel → auth`.

## What this cut proves — and doesn't

Proves: confinement (unforgeable project-scoped binding; raw bindings never reach the sandbox — the
project-app-session secret stays kernel-side), two independent authorities — a **wall** (verify the
ingress JWT; wide open by default) and a **directory** — that let self-host run with **no auth worker**
while hosted reads auth.iterate.com, the capnweb `/api` capability tree (`Os.authenticate(credentials) →
Session → projects.get(id)`, membership-gated, proven live), the **project-app-session** lane (the narrow
token the front door mints so a project app acts as the user without the user's session; mint→verify
proven live via `/__debug`), the real `auth-prd` directory over a same-account `AUTH`
Service binding (reads, proven live), **project creation in both modes** — self-host `kv` proven live
end-to-end (`create → get → list`, real workerd + real KV), and hosted **proven live against auth-prd**:
`create({ organizationSlug })` over the `AUTH` binding wrote a real project row (`kernel-poc-1` under
org `v3-test`) — verified by a follow-up `get` flipping from "does not exist" to "not a member". One
intercepted egress door (the _mechanism_). Does **not** yet build: egress _policy_
(rules/secrets/approval), the durable log, secrets, act-as-user (carrying a real token, done right). See
the review.

## Run / test / deploy

```bash
pnpm test                          # real e2e on workerd (unstable_dev) + directory unit tests
pnpm dev                           # local, wide open + a local KV directory (env.dev); create works offline
pnpm run deploy                    # -> hosted (iterate2): auth-prd directory; wall = an auth.iterate.com proxy (TBD)
npx wrangler deploy --env selfhost # -> self-host (shiterate.com): Cloudflare Access wall + a local KV directory
cd mini-apps/os && pnpm run deploy # the OS dashboard vessel
```

## The knobs (hosted vs self-hosted)

- **wall** (`APP_CONFIG.wall`) — `{ header, jwksUrl, issuer, audience? }`, or omit for **wide open** ✓
- **directory authority** (`APP_CONFIG.directory`) — `auth.iterate.com` · `kv` · `local` · `open` ✓
- **hostname base** (`APP_CONFIG.hostBase` + the route) — `templestein.iterate2.app` vs `shiterate.com` ✓
- **project-app-session secret** (`PROJECT_APP_SESSION_SECRET`) — signs the narrow app tokens; absent => that lane is off ✓
- _(todo, real seams)_ the auth.iterate.com wall proxy · platform egress keys · billing counterparty

Wall and directory are independent: self-host = a Cloudflare Access wall + `kv` (no auth worker); dev =
wide open + `kv`; hosted = an auth.iterate.com wall (proxy TBD) + the `auth-prd` directory.
`OS_DASHBOARD_ORIGIN` is **userspace wiring** (which vessel to proxy).

## Prerequisites (ops)

A two-label wildcard route (`*.templestein.iterate2.app`) needs **Total TLS** (ACM) + a proxied
wildcard **DNS** record — the route declaration alone doesn't provision them (review #16). Cloudflare
Access self-host needs a Zero-Trust org + an Access app over `*.<domain>` (see the review for the AUD).

## Layout

- `src/kernel.ts` — the whole kernel (router, `Os`/`Session`/`Project` capnweb tree, `ProjectEntrypoint`, app config)
- `src/config-worker.ts` — the per-project config `worker.js` (front door, `{fetch, processEvent}`)
- `src/directory.ts` — the directory authority (membership) · `src/directory.test.ts` — its unit tests
- `src/wall.ts` — identity: verify the ingress wall's JWT (Cloudflare Access / auth.iterate.com = configs)
- `src/project-app-session.ts` — mint/verify the narrow project-app-session token (+ `.test.ts`)
- `src/kernel.e2e.test.ts` — real e2e (boots the worker on workerd)
- `wrangler.jsonc` (hosted + `env.selfhost`) · `wrangler.test.jsonc` (routes-free local test)
- `mini-apps/os/` — the OS dashboard TanStack Start vessel
