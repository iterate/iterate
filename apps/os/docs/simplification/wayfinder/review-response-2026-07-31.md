# Code review + hardening response — control-plane & project-worker (2026-07-31)

Four parallel review agents (control-plane auth/OAuth · directory/SQL · project-worker · cross-cutting
security) audited the two workers. Below: every finding, its disposition, and where it landed. After the
pass, all 31 proof assertions stay green (`prove.mjs` 13 · `prove-api.mjs` 4 · `prove-twoworker.mjs` 7 ·
`prove-apps.mjs` 7), and the confined sandbox still sees only `[ITX]`.

## Fixed

| #   | severity         | finding                                                                                                                                                                                                                             | fix                                                                                                                                                                    |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **HIGH**         | **Dial secret + envelope leaked into the confined sandbox** (`project-worker` copied the full inbound header set — incl. `x-iterate-dial-secret` — into the config worker; combined with open egress → cross-tenant impersonation). | `serveConfigWorker` now strips `STRIP_INTO_SANDBOX` (dial-secret, project-id, path, cookie, authorization) before dispatch. Verified the sandbox can't see the secret. |
| B   | **HIGH**         | **Open redirect on `POST /login`** (`next=http://evil.com` / `//evil.com`). Sits next to the OAuth consent flow.                                                                                                                    | `safeNext(next, origin)` resolves against our origin and accepts only same-origin; foreign origins → `/`.                                                              |
| D   | **HIGH**         | **`createProject` threw a raw TypeError on any slug conflict** (`DO NOTHING RETURNING` → 0 rows → `rows[0]!`), so the idempotency + "already taken" branches were dead → 500 on every duplicate.                                    | Dropped `RETURNING`; the query is now a `client.run`; `directory.createProject` re-selects to cover created-vs-existing.                                               |
| E   | **HIGH→partial** | **API-key grants unenforced; mint had no membership check** (a user could assert a grant for a project they don't belong to).                                                                                                       | `/apikeys` now rejects (403) minting a key for a project the minter can't reach. _Read-time_ grant enforcement remains a known gap (below).                            |
| —   | MED              | **Session token never expired server-side** (`iat` captured, never checked).                                                                                                                                                        | `verifySession` now rejects tokens older than `MAX_AGE` and validates `sub`/`iat` shape.                                                                               |
| —   | MED              | **Transport constant / stale docs**: `config-worker` doc described the removed `itx.auth.fetch`; `definitions.sql` said `user:<email>` (must be colon-free); `ids.ts` claimed "auth is the only authority".                         | All three comments corrected.                                                                                                                                          |
| —   | MED              | **`emerge` created a throwaway org per project** (org:project 1:1); `emerge` vs `ensureOrg` had contradictory philosophies.                                                                                                         | `emerge` now REUSES the caller's existing org (creates one only on first use). It's the single create-a-project path.                                                  |
| —   | MED              | **`createOrg` had no slug-collision story** (raw UNIQUE error).                                                                                                                                                                     | Org slug is now collision-proof by construction: `slugify(name)-<id tail>`.                                                                                            |
| —   | LOW              | Non-constant-time dial-secret compare.                                                                                                                                                                                              | `timingSafeEqual`.                                                                                                                                                     |
| —   | LOW              | `slugify` duplicated (two behaviors); missing `api_keys(user_id)` index; `slugify` could yield empty slug.                                                                                                                          | Single `slugify` from `ids.ts` everywhere; `idx_api_keys_user` added; `createProject` rejects empty slug.                                                              |
| —   | LOW              | Header names / `StampedCaller` scattered as literals.                                                                                                                                                                               | Header-name constants centralized in `project-worker`; `StampedCaller` cross-linked between the two files.                                                             |

## Documented as known (POC-acceptable, tracked for productionization)

- **C — `itx.auth.gate` trusts the caller header.** Safe today: the control plane builds a FRESH header set
  on the dial and never forwards the browser's inbound `x-iterate-*` (a browser can't forge membership),
  and the config worker is our fixed template. **Latent:** when arbitrary userspace code is loaded as the
  config worker, private-app enforcement must move to the **runner** (which holds the trusted per-request
  caller) rather than a sandbox-initiated `gate` call. Commented at `ProjectAuth`.
- **Unrestricted `globalOutbound` egress** — the sandbox has open internet access; the kernel's two-level
  egress door (secret substitution, origin-pinning) must land before untrusted multi-tenant use. `TODO(egress)`.
- **API-key grants not consulted at read time** — a key currently inherits its owner's full directory
  authority; `/api` + `/mcp` key off the user, not the key's `grants`. Either enforce (intersect key grants
  with membership at every `get`/`list`) or drop the `grants` field. Mint-time check added; read-time pending.
- **`access` login mode trusts `cf-access-authenticated-user-email`** without validating the Access JWT —
  only sound if Access-in-front is a hard invariant (unreachable otherwise). Validate the JWT for real use.
- **Secrets as plaintext `vars`, duplicated across both wranglers** (`RUNNER_DIAL_SECRET`, `SESSION_SECRET`)
  — demo values on a throwaway account; real deploy uses Doppler-backed secret bindings, single source.
- **Foreign keys are decorative; no `ON DELETE` cascade** — latent (no delete paths yet); decide
  cascade-vs-restrict before tenant deletion lands. Same for **no key expiry/revocation** columns.
- **`emerge`/`createOrg`/`createProject` are not atomic** (three statements, no transaction) — a mid-flight
  failure can orphan an org. Wrap in a D1 batch for production.
- **Ingress is GET-only** — the dial conveys no method/body (both transports agree); POST-to-a-private-app
  needs method/body tunnelling through the envelope.
- **`/__ingress` + `/__debug` are demo affordances** — `/__ingress` is unauthenticated and always mounted
  (it is NOT an arbitrary-host SSRF: `host` is only a routes-table key; the dial always targets the
  configured runner). `/__debug` echoes the caller + bindings. Both gate/remove for non-demo builds.
- **`user_anonymous` sentinel** could in principle collide with a real actor id — practically unreachable
  (real ids derive from a validated email), but worth a reserved-prefix guard eventually.

## Not changed (reviewed, fine)

- HMAC sign/verify is correct (`crypto.subtle.verify`, guards malformed input); `SameSite=Lax` gives the
  consent POST CSRF protection. Loader cache key `project:${projectId}:${CONFIG_HASH}` is correct (no
  cross-project bleed, busts on source change). `gate` taking primitives (not a `Request`) is the right
  shape given `fetch` is reserved over RPC. `redirect:"manual"` on the dispatch is correct. `rows[0]`
  cardinality usage matches sqlfu's PK-vs-unique typing everywhere except the (now-fixed) createProject.
