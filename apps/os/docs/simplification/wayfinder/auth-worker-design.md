# The auth worker — one always-deployed worker: login + session + directory + OAuth AS (2026-07-31)

Jonas's pivot: stop reinventing `wall` + `directory` in the kernel. Instead, **always deploy one small
auth worker** (hosted AND self-host), configured for how login works. It is a **forward-auth "partial
fetch"** for browser pages, the **OAuth 2.1 Authorization Server** for MCP clients, the **device-grant AS**
for embedded devices, and **the directory** (users → orgs → projects → devices) — sharing ONE login UI,
ONE session store, ONE directory. This is a microcosm of `apps/auth` (auth.iterate.com), built in the
clean room.

**Supersedes ADR 0003** ("identity is wall or nothing" → "identity is always the auth worker, configured
wide-open or not") and **ADR 0004** ("directory = open/kv/auth providers" → "the auth worker IS the
directory, always"). Builds on the `auth-as-ingress-wall.md` fork (this is its "option 1", made concrete).

Grounded in the live **MCP `2025-11-25` authorization spec** (OAuth 2.1) — see §4 for the exact mechanism.

---

## 1. One worker, three faces — but one login + session + directory

The auth worker is simultaneously three things. The crux (which resolves "does MCP/device fit the partial
fetch pattern?"): **all three share the same login UI, session cookie, and directory** — they differ only
in what the _unauthenticated_ response is.

| face                                      | client             | unauthenticated response                                                    | after auth     |
| ----------------------------------------- | ------------------ | --------------------------------------------------------------------------- | -------------- |
| **session gateway** (the "partial fetch") | browser app page   | **return the login form** (calling worker returns it verbatim)              | session cookie |
| **OAuth Authorization Server**            | MCP client (agent) | (the RS returns a **401 challenge**; the client comes here to `/authorize`) | bearer token   |
| **device-grant AS**                       | embedded device    | device shows a code; human approves at a verify page                        | bearer token   |

The **human-in-the-loop step of all three is the same login + the same session**:

- browser app page → login form (forward-auth)
- MCP client → the **`/authorize` consent page**, which — if you already hold a session cookie — is just
  "approve" (or auto-approve); if not, shows _the same login form_
- device → the **`/verify` page** → same login → "enter your code" → approve

So it is NOT three auth systems. It is one login/session/directory, reused at three entry points. The
"partial fetch" pattern handles browser pages; MCP and device are **token flows whose browser steps reuse
that same login**.

## 2. The two verify mechanisms other workers call

Every other worker (control plane, project runner, …) delegates auth to the auth worker via two helpers
(service-binding RPC, same-account, ~0 latency):

```ts
// BROWSER pages: return identity, or the login page to hand straight back to the browser.
gate(request): Promise<{ identity: Identity } | { login: Response }>

// MCP / MACHINE / DEVICE: return identity, or a 401 OAuth challenge to hand back.
verifyToken(request): Promise<{ identity: Identity } | { challenge: Response }>
```

The calling worker picks by request shape (a browser page vs `/api`/`/mcp` or an `Authorization: Bearer`):
`gate` for pages, `verifyToken` for machine surfaces. On failure it just **returns the response the auth
worker gave it** — that's the "partial fetch." This is what replaces `auth-wall.ts` (verify-a-JWT) and the
kernel's whole `directory.ts` provider switch.

## 2a. Credentials, `/api` authorization, and API keys — the whole boundary

There are exactly **three credential kinds**, and every one of them resolves to the **same thing**: an
**actor + a set of grants**, where a grant is `{ projectId, scopes[] }`. This is the unifying model —
there is no separate "API-key subsystem," no separate "OAuth subsystem." One actor+grants shape, minted
three ways.

| credential             | who carries it                           | minted by                                     | scoped to                             | validated by                     |
| ---------------------- | ---------------------------------------- | --------------------------------------------- | ------------------------------------- | -------------------------------- |
| **session cookie**     | first-party browser                      | `/login`                                      | the human's full directory membership | our `session.ts` (HMAC)          |
| **API key / PAT**      | a program (CLI, CI, integration, device) | the console (a human picks projects + scopes) | exactly those projects/scopes         | our lookup (hashed key → grants) |
| **OAuth access token** | an external MCP/OAuth client             | the AS after `/authorize` consent             | the project(s) approved at the picker | the provider (OAUTH_KV)          |

Two library facts pin the shape (verified in `@cloudflare/workers-oauth-provider` 0.8.3):

- **`resolveExternalToken(token, request, env) → { props, audience }`** is the provider's PAT/API-key hook:
  any `Authorization: Bearer` that is _not_ a provider-issued OAuth token falls through to this callback,
  which validates it and returns the very same `ctx.props`. **API keys are first-class bearer credentials
  on any protected route, for free.**
- There is **no manual "validate this token" helper** — the provider only validates tokens on `apiRoute`s.
  So a route is either a bearer-validated apiRoute, or it's session-land in the default handler. That fork
  decides `/api`.

### How `/api` authorization works

`/api` (itx) accepts **two** credential kinds, resolved in the default handler — _not_ as an OAuth
apiRoute, because we want OAuth to stay strictly at the MCP/external edge (that discipline is what keeps us
out of the app/os client zoo):

- **From the browser** — the **session cookie** (same-origin; works for both SSR loaders/actions and
  client-side fetch). No token, no OAuth.
- **From a program** — an **API key** as `Authorization: Bearer …` (hashed-lookup → actor+grants).

OAuth access tokens are **not** accepted at `/api` — they exist only for `/mcp`. So `/api` = "session **or**
API key," `/mcp` = "OAuth token **or** API key (via `resolveExternalToken`)." One API-key validator, reused
in both places.

### Who enforces what (the clean split)

- **The auth worker RESOLVES**: credential → `{ actor, grants }`. It answers _who are you, and what were
  you granted._
- **The itx / control-plane layer ENFORCES per call**: is the target `projectId` in `grants`, and is the
  `scope` sufficient? It answers _is THIS call allowed._

The auth worker never needs to know what an itx capability does; the control plane never validates a
credential. That boundary is the whole point.

### API keys, concretely

A directory record `apikey:<sha256(key)> → { actor, grants:[{projectId,scopes}], label, createdAt }` — we
store a **hash**, never the raw key (cf. Better Auth hashed-token storage). Minted in the console by a
human with a session (the project picker again — "which projects can this key touch?"), **revocable**
(delete the record) and **listable** (the console shows them next to OAuth grants via
`listUserGrants`/`revokeGrant`). Presented as a bearer, hashed, looked up, resolved to props. Same grant
model as everything else.

## 3. Config modes = the login backend (not a kernel knob)

The auth worker has ONE knob for _how a human proves who they are_:

- **wide-open** — no login; every request is an anonymous (or single) identity. (The Pi floor.)
- **email-entry** — the login form takes an email; the auth worker owns the session. (Consumer self-serve
  — the mode that fixes the "Cloudflare Access doesn't scale" problem: Access is no longer the wall.)
- **behind-Cloudflare-Access** — the auth worker reads the verified email from the Access-injected header
  (no login form of its own; Access did it). Good for a bounded self-host team.

"Wide open" is now just a login mode, not a special path through the kernel. One code path everywhere.

## 4. MCP authorization — the current spec (2025-11-25), and how it fits

The MCP `/mcp` endpoint is an OAuth 2.0 **Resource Server**. It does NOT render a login. With no token it
returns:

```
401  WWW-Authenticate: Bearer resource_metadata="https://<cp-host>/.well-known/oauth-protected-resource"
```

The client fetches that **Protected Resource Metadata** (RFC 9728), reads `authorization_servers`, finds
the **auth worker**, fetches its `/.well-known/oauth-authorization-server` (RFC 8414), and does
**authcode + PKCE S256** (mandatory) with the **`resource` parameter** (RFC 8707, mandatory — binds the
token to this MCP server so it can't be replayed elsewhere).

**Client identity — CIMD, not DCR (the "new way" Jonas meant).** The live default is **OAuth Client ID
Metadata Documents** (`draft-ietf-oauth-client-id-metadata-document-00`, adopted Oct 2025). The
`client_id` is itself an **HTTPS URL** pointing at a JSON metadata doc (`client_id`, `client_name`,
`redirect_uris`). The auth worker, on seeing a URL `client_id`, **fetches + validates** it (client*id must
equal the URL exactly; redirect_uris must match; **SSRF-guard the fetch**; cache per HTTP headers). **No
`/register`, no client store** — this is \_simpler* for a mini auth worker. Advertise
`"client_id_metadata_document_supported": true` in the AS metadata. DCR (RFC 7591) is demoted **SHOULD→MAY**
— a fallback only; we can skip it. Priority order: pre-registration → CIMD → DCR → prompt.

So MCP auth composes with the forward-auth worker perfectly: the RS side (401 + PRM) can live on the
control plane's `/mcp`; the AS side (`/authorize` consent reusing the login/session, `/token`) is the auth
worker. **`/authorize`'s consent page can include the project picker** — "which project does this MCP
client get?" — which is ADR 0029 ("emerge with a project") for agents.

## 5. Device authorization (RFC 8628) — for embedded devices

Layers onto the same AS with one extra endpoint + token-polling, no new core:

- `/device_authorization` → `{ device_code, user_code, verification_uri, verification_uri_complete,
expires_in, interval }`.
- a **`/verify` page** where the human enters `user_code` — again **reuses the same login + session +
  directory** (+ the project picker: "which project/org is this device for?").
- the device polls `/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`
  (`authorization_pending` / `slow_down` until approved).

Not part of MCP's mandated set, but fully compatible with the same AS. This is the embedded-device story.

## 6. The apps/os project-selection screen — generalized

The picker survives and becomes uniform: it's a **directory-backed screen** (the auth worker holds
orgs/projects), shown at **all three** consent points — the app console, the MCP `/authorize` consent, and
the device `/verify`. Humans, agents, and devices all "emerge with a project" through the same UI + store.
The console I built for `iterate.shiterate.com` becomes this picker, backed by the auth worker's directory
instead of a raw KV.

## 7. Minimum endpoint set (the mini auth worker)

- **Login/session:** the login form (mode-dependent) + a session cookie; `POST /login`, `GET|POST /logout`.
- **Directory:** users → orgs → projects → devices (one store; KV to start, a DO later for consistency).
- **OAuth AS:** `/.well-known/oauth-authorization-server` · `/authorize` (browser page: reuse login +
  project picker) · `/token` · `/device_authorization` + `/verify`. **No `/register`** (CIMD).
- **Resource side (on the control plane's `/mcp`, or co-hosted):** `/.well-known/oauth-protected-resource`
  - the `401` challenge.
- **Two RPC helpers other workers call:** `gate(request)` (browser) · `verifyToken(request)` (machine).

## 8. What this DELETES from the kernel (the simplification)

- `auth-wall.ts` (verify-a-JWT) → gone; replaced by `gate()`/`verifyToken()` calls to the auth worker.
- `directory.ts`'s `open | local | kv | auth.iterate.com` provider switch → gone; the auth worker IS the
  directory (one implementation). The kernel keeps _routing_ (hostname→project) but not _membership_.
- `AppConfig.wall` + `AppConfig.directory` knobs → gone; replaced by "there is an auth worker; its config
  says wide-open/email/Access." Net: fewer kernel concepts, one auth story, hosted == self-host in shape.

## 9. Hard constraints (from the spec — not optional)

All endpoints HTTPS. redirect_uris exact-match, HTTPS-or-localhost. **PKCE S256 mandatory** + advertised
(clients MUST refuse an AS that omits `code_challenge_methods_supported:["S256"]`). Validate
`resource`/audience (RFC 8707) so a token for one MCP server can't be replayed at another. **SSRF-guard**
CIMD `client_id` fetches. Short-lived access tokens + rotating refresh tokens for public clients.

## 10. Build plan (a microcosm, clean-room)

1. **Mini auth worker** in `apps/kernel`: login (3 modes) + session cookie + a KV directory (users +
   projects) + `gate()`/`verifyToken()` RPCs. Wire the control plane + console to call it; delete
   `auth-wall.ts` + `directory.ts` pluggability. Prove: browser login on `iterate.shiterate.com`; the
   console lists/creates via the auth-worker directory.
2. **MCP OAuth**: control-plane `/mcp` becomes an RS (401 + PRM); auth worker gains `/authorize` (+ CIMD)
   - `/token`. Prove: an MCP client (Inspector/Claude CLI) does the OAuth dance and connects — no DCR.
3. **Project picker** at `/authorize` consent (agent emerges with a project).
4. **Device grant**: `/device_authorization` + `/verify` + device-code `/token`. Prove a simulated device.

Steps are independently provable; each is small. Start with 1 (it's the simplification — deletes kernel
code), then 2 (the MCP-auth correctness Jonas flagged).

## Open questions

- **One worker or two** for AS vs the MCP resource server? (Spec allows co-hosting.) Lean: RS logic on the
  control-plane `/mcp` (it already knows the project), AS in the auth worker.
- **Session store vs directory store** — same DO/KV or separate? Lean: one store, two record types.
- **Wide-open + OAuth**: in wide-open mode, does `/authorize` auto-approve a single anonymous identity, or
  is MCP-in-wide-open just tokenless? Lean: wide-open ⇒ `/mcp` needs no token (the Pi case).

## 11. Agenda — userspace app auth as a capability (`itx.auth.fetch`)

A project's own app (running in the **project config worker**, the dynamic worker) must be able to choose
whether it's protected. Expose the same forward-auth "partial fetch" (§2) as an **itx capability the
dynamic worker invokes** — `itx.auth.fetch(request)` — returning identity, or a response (login page / 401)
to hand straight back. Modes the app selects:

- **public** — everyone can access; no gate. (The initial default.)
- **project-members-only** — only users with access to THIS project (session or token → membership check
  against the project's org, i.e. `directory.access`).
- **bring-your-own** — the app does its own auth (Clerk, etc.); `itx.auth` stays out of the way.

This is the _userspace face_ of §2's `gate()`/`verifyToken()`: the control plane's forward-auth, dialable
from project code. Related: [[auth-worker-design]] §2, §3.

### 11a. BUILT + PROVEN — public/private apps via `itx.auth.gate` (2026-07-31)

Implemented and proven deployed (`prove-apps.mjs` 7/7). The mechanism, end to end:

1. **The control plane stamps membership at dial time.** On ingress it resolves the caller (session/API
   key), then `stampFor(actor, projectId)` computes `directory.access` → a **StampedCaller**
   `{ actor, email, member, role }`, JSON-stamped into the `x-iterate-caller` header. The control plane
   **overwrites** this header (a browser can't inject it), so `member` is trustworthy downstream.
2. **The project worker exposes `itx.auth`.** A private app calls
   `env.ITX.auth.gate(callerHeader, cpOrigin, url)` → `{ authorized: true }` (proceed) or
   `{ authorized: false, loginUrl }` (redirect the browser to the control plane's `/login?next=…`).
3. **The config worker decides.** Public app (the default) ignores auth; a private app (here: the `admin`
   app / any `/admin` path) calls `gate` first and returns the login redirect verbatim when not authorized.
   This is the "partial fetch" — the app chooses; the capability owns the policy + the login response.

**Three app policies** (as designed): **public** (no gate), **project-members-only** (`gate` →
`member`), **bring-your-own** (`itx.auth` unused; the app runs Clerk/etc.).

**Two implementation findings worth remembering:**

- **`gate` takes/returns primitives, not `Request`/`Response`.** Over Workers RPC, `fetch` is a **reserved
  method name**, and `Request`/`Response` don't reliably cross the loopback. So the ergonomic "partial
  fetch" is a small value-returning call the config worker turns into a `Response`. (The user's earlier
  `itx.auth.fetch(request)` sketch runs into the reserved name; `itx.auth.gate(...)` is the working shape.)
- **Dispatch to the config worker with `redirect:"manual"`.** A login `302` the config worker _returns_
  must pass to the browser verbatim; the default `redirect:"follow"` on the loader dispatch **follows** it
  back into the worker (re-entering on the `Location`), which silently served the private page. `manual`
  fixes it.

**Trust model (documented for the reviewers):** the membership decision reads the stamped `x-iterate-caller`.
A browser can't forge it (control plane overwrites on ingress). A malicious _config worker_ could pass a
fake caller to `gate` — but that's the project owner's own code choosing whether to gate its own app, not a
privilege escalation (the real capabilities — streams/secrets — are scoped by the unforgeable `projectId`
prop, not by this header). Cross-host cookie note: on real deployments the control-plane login and the
project host share a base domain so the session cookie spans both; on `*.workers.dev` they don't, so the
proof drives ingress through the control-plane origin (which holds the cookie) — the redirect-to-login
path is what's proven, not the post-login cookie hand-off.
