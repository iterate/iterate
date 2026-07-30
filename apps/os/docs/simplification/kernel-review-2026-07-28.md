# kernel PoC review — 2026-07-28

Two independent reviewers audited `apps/kernel` (Codex `gpt-5.6-sol` xhigh; Fable xhigh)
against the vision docs, Cloudflare Workers best practice, and capnweb idiom. They converged
hard, which makes the consensus findings high-confidence. This file is the durable record; the
source cites it by number (e.g. `// review #7`).

## The guiding principle these fixes respect

**Unauthenticated is the default and a first-class mode.** With no `APP_CONFIG` (or
`{identity:{provider:"none"}}`) the kernel verifies nobody and every caller is anonymous — and
that is _correct_, not a gap. You put the wall in front (Caddy basic-auth, an authenticated
Cloudflare Tunnel, Cloudflare Access) or you let the kernel verify a credential itself
(`auth.iterate.com` OIDC, `cloudflare-access`). Three ways to answer "who is the caller?":

1. **nobody** — anonymous (default). The app doesn't care who you are; a wall in front may gate.
2. **an upstream proxy** — Caddy / Tunnel / Access injects a header; set `provider` so the kernel verifies it.
3. **the kernel itself** — `auth.iterate.com` OIDC.

So findings that read "auth-free is insecure" are **reframed**: auth-free is intended. What we fix
is _forgeable_ verification, _leaked_ credentials, and _dishonest_ docs — never "make auth mandatory".

**Simplicity is above almost everything.** The kernel is ~200 lines and that is the product. Real
bugs get tiny fixes; the big architectural rocks become **documented seams** (a named spot + this
doc), not code we write speculatively. No policy engines, no config frameworks, no error taxonomies.

Legend: ✅ fixed · 🌱 seam (named in code, built later) · 📄 doc-only · 🔵 reframed / won't-fix.

## Security

- **#1 ✅ [Codex] Stub session verifier was live in production.** `verifiersFor` installed
  `stubSessionVerifier` in hosted mode, so `Authorization: Bearer session:anyone` forged a verified
  caller. → the stub now only exists when `INSECURE_STUB_AUTH=1` (test config only); prod never sets it.
- **#2 ✅ [both] Session verify omitted `audience`.** The callback checked `aud`, per-request verify
  didn't → any auth.iterate.com id_token for any client was accepted. → verify `audience: clientId` everywhere.
- **#3 ✅/🌱 [both] Raw credentials leaked to the vessel + into HTML.** The proxy copied
  `Cookie`/`Authorization` to the separate vessel origin, and `/__itx` returned the raw signed token
  which SSR rendered into HTML. → the proxy strips `Cookie`/`Authorization`; the caller published past
  the door (header + `/__itx`) carries only non-secret credential metadata (`format`, `issuer`, chosen
  non-secret fields), never the raw signed token. The raw token stays kernel-internal. 🌱 the full
  answer (a short-lived, project-scoped token per `remote-apps.md`) is the seam for when a vessel must
  _act as_ the caller, not just show who it is.
- **#4 ✅/📄 [Codex] Vessel SSRF + exposed on workers.dev.** SSR fetched
  `https://${x-iterate-project-host}/__itx` with an attacker-controlled host. → the SSR fn only
  fetches hosts matching an allowed suffix. 📄 fully removing the workers.dev surface (disable
  `workers_dev`, service-binding the kernel) is noted, not done — it's a demo origin.
- **#5 🔵 [Codex] No project-member authorization gate.** Reframed: authorization is **userspace**.
  The kernel authenticates (optionally) and forwards; the config worker decides who may do what. 🌱
  named seam in `config-worker.ts` where a real one runs an `itx.auth`-style member check before proxying.

## Vision alignment (big rocks → seams)

- **#6 ✅ [both] `/__itx` data-RPC → real capnweb `/api` capability tree.** BUILT (2026-07-28).
  `/__itx` is gone. `/api` serves an unauthenticated root `RpcTarget` (`ProjectApi`) whose only method
  `authenticate()` verifies the request and returns the attenuated `Project` (`whoami()`, `caller()`),
  over `newWorkersRpcResponse` (WebSocket + HTTP batch). Mirrors apps/os's
  `UnauthenticatedOsRpcTarget.authenticate() → Session` exactly. The vessel client + e2e + a live prd
  WS dial all exercise it. capnweb's `RpcTarget` IS the `cloudflare:workers` one, so the same tree is
  reachable in-worker (env.ITX) and on the wire (`/api`).
- **#7 🌱 [both] The egress door enforces nothing.** `return fetch(request)` — interception is real and
  workerd-enforced (verified: no bypass), but rules / secret-substitution / approval / metering are a
  named seam on that one method. The _mechanism_ is the point of this cut; the _policy_ is later.
- **#8 ✅ [both] `env.ITX` and `globalOutbound` were two different instances.** `scoped()` was called
  twice. → mint one `projectEntry` and bind it to both, per the "one thing is both" tenet.
- **#9 ✅ [both] §17 per-call-caller — DISSOLVED for `/api` (2026-07-28).** The capnweb realization makes
  it moot: each `/api` session authenticates once and the verified caller is **baked into the returned
  `Project` `RpcTarget`** (session-scoped), so every subsequent call already carries it — no per-call
  envelope needed. The envelope remains a seam only for the INTERNAL `env.ITX` loopback path, where the
  caller still rides as the kernel-stamped header (props are per-instance, not per-request).
- **#10 📄 [both] Two of three world-contacts (durable log, secrets) are absent; `processEvent` is a
  stub.** Honest scope: this cut proves confinement + identity + egress interception. The log + secrets
  are the next cut. Documented, not hidden.
- **#11 ✅/📄 [both] `OS_DASHBOARD_ORIGIN` is userspace wiring, not a kernel identity knob.** Removed
  from the README's "knobs" list; it's the config worker's concern. Left threaded for the skeleton with a
  comment (moving it into config-worker/`itx.kv` is the userspace home).

## Cloudflare correctness

- **#12 📄 [Fable] Loader factory captures request-scoped `ctx.exports` stubs.** **Verified against CF
  Context docs: sanctioned** — customizing props for the `env` of a dynamically-loaded worker is the
  documented use; `get()` keeps them warm. Not a bug. Documented so we don't re-flag it.
- **#13 ✅ [both] Loader cache key wasn't versioned.** → key includes a hash of the config source, so a
  config change is a new isolate.
- **#14 ✅ [both] Arbitrary host labels manufactured arbitrary projects** (`kernel.workers.dev` →
  project "kernel"; billing DoS). → `resolveProjectId` requires `<slug>.<hostBase>` against the
  configured base; anything else is 404.
- **#15 ✅ [both] Hand-rolled platform types + `as unknown as`.** → use ambient `WorkerLoader` and
  `WorkerEntrypoint<Env, ProjectProps>`; deleted the local interfaces (net simpler), one explained cast
  left for the experimental `ctx.exports`.
- **#16 📄 [both] Wildcard DNS/TLS isn't provisioned by the route alone.** Two-label wildcard needs
  Total-TLS + a proxied wildcard DNS record — documented in the README.

## Identity / OIDC (`auth-iterate.ts`)

- **#17 ✅ [both] Open redirect in `next`.** → only same-origin relative paths accepted.
- **#18 🌱 [both] One OIDC client can't cover every project-host callback.** Works for the demo host;
  the real answer (one fixed auth callback + project host carried in signed state) is a named seam.
- **#19 ✅ [both] id_token used as session; no `nonce`.** → `nonce` added + verified (replay binding);
  the id_token-as-cookie is kept with a seam comment for a real short-lived server session.
- **#20 🔵 [Codex] Auth failure → anonymous.** Reframed: anonymous is a valid state (see the principle).
  A _present-but-invalid_ credential falling back to anonymous is acceptable when a wall may sit in front;
  documented as deliberate, not a taxonomy to build.
- **#21 ✅ [Codex] Cookies partly hardened.** → `__Host-` cookie names + `Cache-Control: no-store` on auth responses.

## Clean / test / docs

- **#22 ✅ [both] Headline e2e test was a false positive** (`toContain("OS dashboard")` matched the
  "not configured" landing). → the test now drives a real proxied origin and asserts distinct content.
- **#23 ✅ [both] README overstated the proof.** → honest rewrite: a confinement + identity skeleton,
  what's proven vs a seam, evidence dated.
- **#24 ✅ [both] format/lint not clean.** → oxfmt + oxlint pass.
- **#25 📄 deps pinned, `jose` 5 vs repo 6.** Noted; aligned where safe.
- **#26 ✅ [Fable] Stale `{principal,assurance,via}` type in the vessel.** → typed to the real `{credentials}` shape.

## The capnweb `/api` shape — BUILT (2026-07-28)

- `/api` → `newWorkersRpcResponse(request, new ProjectApi(...))`; `ProjectApi extends RpcTarget`, exposes only `authenticate()`.
- `authenticate()` verifies the request (does not reduce the credential) → returns an **attenuated** `Project` `RpcTarget` (`whoami()`, `caller()`, …).
- `fetch` stays a literal method (ingress/egress/WS). The per-call caller envelope is unneeded for `/api` (session-scoped, #9); it remains a seam only for the internal `env.ITX` loopback.
- `env.ITX` = Workers RPC onto the **same** capability surface (capnweb `RpcTarget` ≡ the `cloudflare:workers` target; they interoperate).
- Mirrors apps/os: `UnauthenticatedOsRpcTarget.authenticate() → SessionRpcTarget → projects.get(id)`. The kernel's is the two-node minimal of that.

## Topology reshape — OS-root + directory authority (2026-07-28, after the design discussion)

Jonas pushed back on the earlier per-hostname `/api`: it should be like apps/os (`authenticate` on
the OS, `session.projects.get(project)`), and hosted should keep auth.iterate.com as the source of
truth for which projects exist while self-host works with no auth. We reasoned it through (three
research agents mapped apps/os, the vision docs, and apps/auth) and landed here:

- **`/api` is the OS front desk, mirroring apps/os:** `Os.authenticate()` → `Session` →
  `session.projects.get(id)` → `Project`. Deployment-wide, not project-scoped by hostname. The
  hostname only decides which project's web app is served. (`kernel.ts` `Os`/`Session`/
  `ProjectCollection`/`Project`.)
- **Identity and directory are TWO separate pluggable authorities** (not one "auth" knob). Identity =
  who you are (none / access / auth.iterate.com). Directory = which projects exist + membership
  (`open` / `local` / `auth.iterate.com`). `projects.get(id)` is the membership gate. (`directory.ts`.)
- **The cycle we avoided:** we first considered moving the directory _up_ into the `os` project, but
  that makes auth (which creates projects during OAuth) call _into_ the kernel — `auth → kernel →
auth`, exactly the jam §13 fragility. Resolution: the directory's existence-write stays _below_ the
  kernel. Hosted → auth.iterate.com owns it (its OAuth flow writes "exists" and signs a `projects`
  claim; the kernel only _reads_ that claim — no call to auth, acyclic). Self-host → a `local`/`open`
  directory in the kernel's own config, no auth at all, cycle-free because there's no OAuth-create.
- **Claims-in-token lever — RESOLVED to the live binding (2026-07-28).** The hosted directory now
  binds the real `auth-prd` worker over a same-account `AUTH` Service binding (`{binding:"AUTH",
service:"auth-prd"}`, possession = credential, default export = auth's `AuthWorker` RPC class) and
  calls `getProjectBySlug` (existence) + `listProjectsForUser` (membership, keyed on the token `sub`)
  — **reads only**, so it never mutates the production directory. The earlier claims-decoding path is
  gone. Proven live: an anonymous dial → `getProjectBySlug("alice")` on auth-prd → null →
  `denied: no such project 'alice'` (a clean denial, not an error, proves the RPC round-tripped). The
  dependency is still one-way `kernel → auth`, acyclic.
- **Project CREATION — built in both modes (2026-07-29).** `session.projects.create({name})` births a
  project through the configured directory. Self-host adds a `kv` provider (a local KV registry) —
  create/get/list proven live end-to-end against `wrangler dev` with a real KV (`create({name}) →
{projectId:"acme-co"}`, then `get` in a fresh request returns it, then `list` enumerates it). Hosted
  wires `auth-prd`'s `createProjectForOrganization` (org taken from the caller's `organizations`
  claim), unit-tested against a mock. **The actual prod write is deliberately NOT fired** — it would
  insert a real project row in a real customer org (no delete RPC exists), so the first live hosted
  create awaits an explicit go-ahead + a chosen org. `open` = create is trivial (exists by naming);
  `local` = read-only (refused).

## What this cut honestly proves

Confinement (unforgeable project-scoped binding; raw kernel bindings never reach the sandbox),
optional pluggable identity (none / Cloudflare Access / auth.iterate.com OIDC), one intercepted egress
door (mechanism, not policy), a separately-deployed vessel reached through the project, and **the
capnweb `/api` capability tree** (`authenticate() → attenuated Project`, proven over a live prd
WebSocket). It does **not** yet prove: egress policy, the durable log, or secrets.
