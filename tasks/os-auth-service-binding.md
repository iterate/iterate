---
state: todo
priority: medium
size: medium
tags: [os, auth, security, performance, cloudflare]
---

# Move OS→auth runtime calls onto a Workers RPC service binding

Today OS reaches the auth worker's project directory over the **public
internet**: `apps/os/src/auth/auth-worker-service.ts` builds an HTTP oRPC client
(`@iterate-com/auth-contract`) and calls `internal.project.bySlug`,
`internal.project.createForOrganization`, `internal.project.mintProjectId`, and
`internal.oauth.introspectAccessToken`, authenticating with a shared
`x-iterate-service-token` (`SERVICE_AUTH_TOKEN` / `config.iterateAuth.serviceToken`).

Both workers live in the same Cloudflare account, so this hop can instead be a
**[Workers RPC service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)** —
worker-to-worker, no public DNS/TLS/edge round-trip, and **no shared secret**
(possession of the binding is the authorization).

This was prototyped and then deliberately split out of PR #1594 to keep that PR
focused on the deep-linkable routes, session-token leak fixes, and docs. The
prototype is preserved in this branch's history (commits before the revert):
`9179f39a9` (original) plus the merge/dedup commits.

## Why it's worth doing

- **Drops a long-lived secret from OS worker runtime config.** No
  `x-iterate-service-token` in OS env → smaller leak surface (cf. the prior
  `/api/__internal/debug` prod secret-leak incident).
- **Latency.** Removes a public-internet hop on the OS ingress hot path
  (`<slug>.iterate.app` → project id) and the OAuth callback path. Relevant to
  `tasks/fix-cold-auth-oauth-callback-latency.md`.
- **Native, typed worker-to-worker calls** — the Cloudflare-blessed pattern for
  two workers in one account.

## Shape that worked in the prototype

1. **Contract** (`@iterate-com/auth-contract`): add an `AuthWorkerRpc` interface
   (`createProjectForOrganization`, `getProjectBySlug`, `listProjectsForUser`,
   `mintProjectId`, `introspectAccessToken`) + a slim `UserProjectRecord`.
2. **Auth worker entrypoint** (`apps/auth/src/server/worker.ts`): change
   `export default app` → `export default class AuthWorker extends
WorkerEntrypoint implements AuthWorkerRpc`, where `fetch` runs the existing
   Hono app and the named methods are the RPC surface. A plain
   `export default { fetch }` object cannot expose RPC. Move the directory logic
   into a plain-function module (`project-directory.ts`) that both the RPC
   methods and — if still needed — the HTTP handlers call, so there is ONE
   implementation.
3. **OS binding** (`apps/os/alchemy.run.ts` + `src/env.ts`): bind `auth-<stage>`
   as a **required** `AUTH` binding on every OS worker (`authWorker = () =>
env.AUTH`). Required-with-no-fallback is correct: OS already can't boot
   without a live auth worker (deploy-time JWKS bake + all logins). New
   environments must deploy **auth before OS** (Cloudflare rejects the OS deploy
   otherwise — the intended loud failure).
4. **OS callsites**: `apps/os/src/project-directory.ts`, `src/auth.ts` (stale-
   claims `listProjectsForUser`), and `mcp-handler.ts` (`introspectAccessToken`)
   call `authWorker().<method>()` instead of the HTTP client. Then delete the
   now-dead `internal.project.*` + `internal.oauth.introspectAccessToken` HTTP
   routes and `auth-worker-service.ts` (keep the HTTP client only for the
   remaining non-worker callers: CLI + deploy/test-seeding scripts, which can't
   hold a binding).
5. **Local dev**: the binding must be a
   [remote binding](https://developers.cloudflare.com/workers/local-development/#remote-bindings)
   so `env.AUTH.method()` (fetch _and_ RPC) proxies to the deployed auth worker
   for the stage — unless `apps/auth` is running locally (loopback issuer), which
   resolves through the local dev registry. This needed a small extension to
   `patches/alchemy@0.83.3.patch` so generated wrangler configs emit
   `remote: true` for a service binding carrying `dev.remote`.

## Gotchas hit during the prototype

- **Remote-binding RPC in local dev** relies on wrangler's capnweb proxy worker;
  it works but is easy to misconfigure (loopback vs remote issuer decides which
  path is taken — guard `dev: { remote: ctx.app.local && !authIssuerIsLoopback }`
  and tolerate a malformed issuer via `URL.canParse`).
- **`ensureOAuthClient` dev keep-path bug** (unrelated but nearby): a dev client
  must only be _kept_ when matched by the caller's own client id, else a
  db reset hands back a clientId paired with an unverifiable secret.
- Keep the HTTP oRPC surface for callers that physically can't hold a binding
  (browser UI, `iterate` CLI, deploy/test Node scripts). The binding is
  additive for the worker→worker path only.

## Doc touch-ups when this lands

- `apps/auth/README.md`: flip "three surfaces" back to four (re-add the Workers
  RPC row + section), update "How it fits with apps/os", and the trust model
  ("the binding is itself the credential"). Remove the "Planned" note.
- `CLAUDE.md`: the auth-app bullet.
