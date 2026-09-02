# One fetch, ruled by events — synthesis of six design cuts (2026-09-01)

Clean room `packages/v3/project-worker`, written at 69080fd9e (C7) and **re-aligned 2026-09-02 to the
onion tree** (`docs/design-onion-subscriptions-processors.md`, commits 45a8f8432 → 695c3cc74). Six
agents explored: (1) the rules model,
(2) ingress, (3) egress/secrets/HITL, (4) identifiers, (5) the dynamic-worker trick + refactor plan,
(6) tutorial fit + adversary. The six full reports (~3000 lines) live in the session scratchpad: `/private/tmp/claude-501/-Users-jonastemplestein--herdr-worktrees-iterate-simplification/eed333f2-1be1-4387-aa4c-4725fbc203dd/scratchpad/fetch-rules/`. This is the
converged design, with the disagreements decided — and one decision (D3) REOPENED by the onion.

### What the onion changed under this plan (re-alignment, 2026-09-02)

- Files moved: `src/core/*` → `src/context/*` (`worker-loader.ts`, `capability-table.ts`,
  `expression.ts`), `src/stream-durable-object.ts` → `src/iterate-context-durable-object.ts`,
  `itx-surface.ts` → `iterate-context.ts` + `session.ts`, `core/events.ts` → `stream/events.ts`.
- **`itx.fetch` already exists** — as the `fetch` root in `context/built-ins.ts`, as
  `IterateContext.fetch` on the edge, and as what `ItxEntrypoint.fetch` (globalOutbound) reaches. All
  three land on the DO's `#egress` today. This plan changes the BODY of that built-in, not its existence.
- **Mounts carry NO policies.** capability-table 5.0.0 is `{ path, target }` and nothing else;
  `delivery` and `processor` are gone. The one filter the platform needed before evaluating a target
  (a subscriber's `consumes`) became its OWN table — `subscription-configured { name, target, consumes? }`
  reduced inline, `itx.subscriptions.list()`. D3 ("a rule is a mount with a `fetch` policy") therefore
  contradicts the landed doctrine and is reopened below.
- `itx.subscribers.*` is gone (it was the precedent D1 cited); `itx.connections` is `itx.rpcStubs`;
  `provideCapability` is `provide`; `fetchCap` is gone (a terminal `itx.x.fetch(request)` rides the
  fetch lane from inside a session, `iterate-context.ts`); `DEFAULT_CTX`/`?ctx=` are gone — the door
  is `/cap?context=<id|name>&cap=<expr>` and 400s without both, so defect 28 is already closed.
- The `cd` codec defect (D5) is fixed: `resolveContextPath`/`normalizePath` in
  `context/durable-object-names.ts`, shared by the edge `cd` and the built-in root.
- A processor is now two classes — a pure `StreamProcessor` and a one-field
  `StreamProcessorDurableObject` host — and the host is an ordinary DO class that may define more
  methods, so the approval gate (D4) can be a processor host with a `fetch` door.
- Sessions: a client reaches a project through `authenticate().projects.get(id)` on `/api`.

## 0. Verdict

The idea is right, and most of it is already true in the tree:

- **The trick already holds.** `confinedWorker` binds `globalOutbound: host` where host is the
  `ItxEntrypoint` stub (`src/context/worker-loader.ts`); its `fetch` is one line into the context
  DO's `fetch` (`src/itx-entrypoint.ts`); the DO's fetch is already an ordered walk of partial fetches
  (`src/iterate-context-durable-object.ts` `fetch`: the stub-pager door, the upgrade-leg door, the
  `x-itx-cap` lane that resolves an expression) ending in the tail, `#egress` (secret substitution →
  502 on a leftover project token → `FALLBACK.fetch`). The ONLY non-expression part is that tail. And
  the built-in `itx.fetch` root already exists — it IS that tail. No new hop anywhere.
- **A rule is a stored `?cap=`.** Today's header lane IS a rule carried on the request. The design is:
  make the tail data, and let the door derive the expression from the request's host (ours ⇒ an app label, else the internet).
- **Not fewer concepts** (adversary's count: 9 → 10). The wins are elsewhere: policy becomes replayable,
  revocable, snapshot-visible data; apps/os's ~460-line approval gate, ~1000-line Secret DO, EgressPipe
  and the config-worker front door never get ported; the tutorial's Chapter 2 halves.

## 1. TODAY vs AFTER

```
TODAY
 browser  GET /cap?context=prj_x&cap=itx.site ──► edge: ?cap → x-itx-cap ─┐
 capnweb  itx.site.fetch(req) (terminal fetch rides the lane) · itx.fetch(req) (egress) ─┤
 dyn worker  fetch(url)  (globalOutbound = ItxEntrypoint) ────────────────┤
                                                                          ▼
                 DO.fetch: pager door → upgrade-leg door → x-itx-cap lane (resolve expr.fetch(request))
                           → else #egress: {{secret:project:*}} → 502 on leftover → FALLBACK.fetch
 (no hostnames; itx.fetch IS the egress tail — a built-in whose body is code, not data;
  /cap without both params is a 400, so defect 28 is closed)

AFTER  (one built-in: itx.fetch — Jonas: no itx.egress; the door tells internal hosts from the rest)
 browser  https://site--myproj.iterate.app/x      https://site.example.com/x
              │ edge: host ──directory──► projectId   (hostnames = a PROJECT property, many → one)
              │       strip inbound x-itx-*; URL + path VERBATIM
              ▼       → ROOT context DO .fetch(request)           (a real fetch hop: 101-legal)
 capnweb  itx.fetch(req) ───────────────────────────────────────────┐
 dyn worker  fetch(url)  (globalOutbound — UNCHANGED) ──────────────┤
                                                                    ▼
      DO.fetch: pager door → upgrade-leg door → x-itx-cap lane (internal callers naming an expression) → else itx.fetch
      itx.fetch(request) — THE door, in-DO:
        1. rules: newest → oldest itx.fetch.* rows whose policy matches (app | hosts | methods | pathPrefix | headers | secrets)
             stamp x-itx-fetch-below: <row offset>; target.fetch(request) ⇒ Response   ← MIDDLEWARE: the target answers,
             or forwards by fetching the SAME request again (bare fetch() / env.ITX.fetch / itx.fetch) — the door
             sees the stamp and resumes BENEATH that row; it may then observe/transform the Response it gets back
        2. is request.url's host OURS?  platform convention (<app>--<slug>.<base>, <slug>.<base>, prj_<id>.<base>)
                                        ∪ directory rows (custom domains) — one cached read via FALLBACK
             yes → label → resolve itx.apps[.<label>].fetch(request)   (laptop stub | loaded worker | cd(...); 101 rides the fetch channel)
                   no mount ⇒ NO_CAPABILITY_MATCH ⇒ 404                  (the tail is UNREACHABLE for our own hosts)
             no  → the tail: {{secret:project:*}} + origin pin → 502 on leftover → redirect:"manual" → FALLBACK.fetch
```

Direction is a fact about the request's host, decided at the END of the walk by the one built-in. No
direction flag on any event, no second root, no exit-by-name, and defect 28 (an unrouted public request
falling into egress) stays dead structurally: an internal host with no mount is a 404.

## 2. The six decisions (where the cuts disagreed, and the pick)

### D1 Ingress: exposing is providing (agent 2), label as the address (agents 1, 4, 5, 6 agree)

An app is selected by a HOSTNAME LABEL, never a path prefix (Jonas's constraint: tunnelled apps must
serve at `/`). The label is an IDENT, so it is a legal capability-path segment; a URL is not. Hence:

```jsonc
// `iterate tunnel site 3000`  ==  itx.provide("itx.apps.site", new Tunnel(3000))   — ONE call, ONE event
{ "path": "itx.apps.site", "target": "itx.rpcStubs.get('itx.apps.site')" }
// decoupled: the stub, callable by agents as itx.site.fetch — plus the exposure
{ "path": "itx.site",      "target": "itx.rpcStubs.get('itx.site')" }
{ "path": "itx.apps.site", "target": "itx.site" }
// a deployed app; the apex/default app; a sub-context's app (the DO-name convention as ONE rule kind)
{ "path": "itx.apps.docs", "target": "itx.load(\"itx.kv.get('src/docs.js')\").getEntrypoint()" }
{ "path": "itx.apps",      "target": "itx.load(\"itx.kv.get('src/home.js')\").getEntrypoint()" }
{ "path": "itx.apps.bot",  "target": "itx.cd('/agents/bot').apps" }
```

- One row serves the label on EVERY host the project has now or later (`site--myproj.iterate.app`,
  `site.example.com`, a domain added next week): the directory maps hosts → `{projectId, app}`; the
  context's log never names a hostname (directory state has a different lifetime than the DO's log).
- The DO is untouched for ingress: the existing fetch lane already resolves any expression, appends the
  terminal `.fetch`, passes the Request verbatim, maps `NO_CAPABILITY_MATCH → 404`, carries 101s.
  `itx.provide('itx.apps.site', tunnel)` + `/cap?context=…&cap=itx.apps.site` works on deployed code today.
- Why `itx.apps.<label>` and not root-level `itx.<label>` (agents 4/6's variant): exposure is an explicit
  act (a mounted capability is not public until exposed), no collision with built-in root names, zero
  DO code. (The `itx.subscribers.*` precedent this once cited is gone — subscriptions are their own
  table now; the argument stands without it.) The decoupled spelling keeps `itx.site` as the callable.
- Ingress middleware (auth in front of `site`) comes in two equivalent spellings: composition in the
  target (`itx.apps.site ⇒ itx.load(<gate>).getEntrypoint()`, a 5-line gate that calls
  `itx.auth.fetch(req)` — a future built-in: cookie verify, membership via the control plane — then
  `itx.site.fetch(req)`), or a rule `{ path: "itx.fetch.gate", fetch: { app: "site" } }` whose
  target forwards with `fetch(request)` and so wraps the app (D2). Same event shape either way. A
  route, a rule and an app are all one thing: an event whose target expression evaluates to a Fetcher.
- Public `/cap?cap=` dies; `x-itx-cap` survives as the INTERNAL argument channel of a real fetch hop
  (apps/os's `x-iterate-worker-dispatch` role). A second laptop shadows (newest wins); revoke restores.
  A crashed laptop leaves a row that answers `CONNECTION_OFFLINE` — the lane maps only
  `NO_CAPABILITY_MATCH → 404` today and everything else to 500; make offline a 503.
- Captun becomes unnecessary inside a project; still needed for non-project things (OS dev server,
  auth OAuth callbacks, CI fixtures) and until the clean room leaves workers.dev for a wildcard zone.

### D2 One built-in, `itx.fetch` — no `itx.egress` (Jonas's call; agent 3's door convention)

- `itx.fetch(request)` is the ONE door and it is a built-in (physical: it owns the Request, the walk,
  the host decision, the secret tail, the 101-legal channels). Its behaviour is entirely data: the
  `itx.fetch.*` rule rows and the `itx.apps.*` mounts. It already IS the declared `IterateContext.fetch`
  on the edge, the `fetch` root in `built-ins.ts`, and what `ItxEntrypoint.fetch` reaches — all three
  land on `#egress` today; the design puts the walk in FRONT of that tail. The globalOutbound wiring
  is unchanged.
- **Rules are middleware; "next" is spelled `fetch`** (Jonas: rules must be able to observe responses;
  agent 1's mechanism). A rule target is fetch-shaped, `(request) => Response`. The door stamps the
  request with a door-owned header `x-itx-fetch-below: <providedAtOffset>` (beside `x-itx-stub-pager`
  and `x-itx-fetch-upgrade`) and calls `target.fetch(request)` on the terminal-fetch channel. The
  target either answers (deny, mock, 403 after a rejected approval) or FORWARDS by fetching the same
  request again — a loaded worker's bare `fetch()`, a facet's loopback, `itx.fetch(request)` over
  capnweb — and the door, seeing the stamp, resumes beneath that row: the older matching rules, then
  the tail. The target gets the downstream Response back and may observe or transform it (audit
  `status`, rewrite a body, record `released{status}`). A fresh request without the stamp starts at the
  top — correct: a gate that pings Slack is making a new egress, which its own rules may hold. The tail
  strips the stamp. No `super`, no `next` argument, no new noun — apps/os's `itx.super.fetch` without
  the noun. This is 101-safe precisely because the forward is a REAL fetch hop (globalOutbound →
  entrypoint → DO), so a 101 from the tail or an app mount rides back through every wrapper on fetch
  channels; a `next(request)` handle passed as an ARGUMENT would be an RPC call returning a Response,
  and a socket-bearing Response cannot cross RPC (the WORKAROUND class) — that variant is out.
- **The tail decides direction by the request's host.** Ours = the platform convention
  (`<app>--<slug>.<base>`, `<slug>.<base>`, `prj_<id>.<base>`; the DO knows its projectId, the slug and
  the bases come from ONE directory read through FALLBACK, cached for the incarnation — the control-plane
  shell already stubs `itx.auth.gate` the same way; solo/tests: slug = id, base = the worker's own host)
  ∪ custom-domain rows (`routes(host, project_id, app)`, same cached read; a domain added while the DO
  sleeps is seen on the next miss). Ours → derive the label → `itx.apps[.<label>].fetch(request)` in-DO
  (a dynamic worker fetching its own project's app never leaves the DO; no mount ⇒ 404). Not ours →
  `{{secret:project:*}}` with the origin pin → 502 on leftover → `redirect:"manual"` → `FALLBACK.fetch`
  (`(env.FALLBACK ?? { fetch })`, so `DummyControlPlane` dies).
- The edge therefore only picks the DO (host → projectId via the directory) and strips inbound
  `x-itx-*`; it may pass the label it already derived as a cache of the same decision, never as the
  authority. Rule matchers use `app` (derived from the host) rather than hostnames, so the log never
  names a domain.
- Costs, honestly: one loopback hop per WRAPPING rule (target → entrypoint → DO); rules that merely
  match and decline cost nothing (the door skips them in-DO). The footgun: a target that builds a brand-new
  Request without copying headers drops the stamp, re-enters at the top and matches itself — the hop guard
  makes that a 508 after 8 hops, not a hang; the rule is "forward the request you were handed"
  (`new Request(request, {...})` keeps it). Secrets stay structural: the tail substitutes AFTER the last
  wrapper, so a wrapper sees placeholders on the way in and the Response on the way out, never material
  (a response may echo a credential — the destination leaking, bounded by the origin pin, identical to
  apps/os interceptors). A laptop-side (capnweb) middleware works too: its `fetch(request)` receives the
  Request over the session (the fork carries Request/Response, 101s as stream pairs) and forwards via
  `itx.fetch(request)` — double-tunnelled, but the fence branches only on "the answer carries a socket".
  The DO takes a cached dependency on the directory for its own host list.

### D3 Where a rule's MATCH lives — REOPENED by the onion (was: "a mount with a `fetch` policy")

The six cuts converged on the shape below. The onion then established that a mount is `{ path,
target }` and nothing else, and moved the one pre-target filter the platform has (`consumes`) into a
table of its own. The rule shape stays; where the matcher lives is the open question — see §6 Q1.

```jsonc
{
  "type": "events.iterate.com/capability-table/capability-provided",
  "payload": {
    "path": "itx.fetch.transfers",
    "target": "itx.facets.get('approvals')",
    "fetch": {
      "hosts": ["api.stripe.com", "*.stripe.com"],
      "methods": ["POST"],
      "pathPrefix": "/v1/transfers",
      "headers": { "x-env": "live" },
      "secrets": ["STRIPE"],
    },
  },
}
```

- The matcher (`fetch` above) is conjunctive; absent = match all; `hosts` with apps/os's `*.`
  wildcard; `secrets` = "the request spends `{{secret:project:NAME}}`". Copy
  `matchEgressRule`/`hostMatches` from apps/os `egress-approvals.ts`, pure and Node-testable. `app` =
  the label the door derived from one of OUR hosts, so a rule can hold or gate ingress too ("every
  POST to app `site` needs approval") without a hostname ever entering the log. THREE homes for it:
  - **(a) a `fetch-rules` table shaped like subscriptions** — `fetch-rule-configured { name, target,
match? }` / `fetch-rule-removed`, one inline reduce (~60 lines, the `stream/subscriptions.ts`
    shape), `itx.fetch.rules.list()` as the read door. Honest to the onion: a matcher is "which requests
    are SENT to this target, decided before the target is called" — exactly what `consumes` is for
    events. Non-matching rules cost nothing. RECOMMENDED.
  - **(b) no matcher in data** — every `itx.fetch.<name>` row is a plain mount; the door calls each
    newest → oldest and the TARGET decides (answer, or forward by re-fetching). Zero new events, zero new
    reduce; but one loopback hop per rule per request even for rules that don't care, and a rule's
    scope is invisible in any snapshot.
  - **(c) the original** — a `fetch` field on `capability-provided`. Smallest diff, but it re-opens
    exactly the door the onion closed (mounts carrying policy) for one consumer.
- Order = **newest `providedAtOffset` wins** — the table's existing tie rule. First-match needs a
  whole-list event (not a log); longest-match has no meaning over a multi-field matcher. Consequence:
  re-rank by revoke + re-provide; an interposer must be newer than the terminal-ish rule it wraps.
  Documented, not engineered.
- Named rows (`itx.fetch.<name>` under (b)/(c), `name` under (a)) rather than all-at-`itx.fetch`
  (agent 1): revocable by name, readable in a snapshot. Under (b)/(c) the provide door already accepts a
  path under a built-in root name (checked: no refusal in `provide`); by-name resolution of
  `itx.fetch.<name>` hits the built-in first (`capability-table.ts` BUILT-IN FIRST), which is fine —
  rows are consumed by the door by identity, the way the delivery loop consumes subscription rows.
  Idempotent configure compares `match` alongside `target` (as `subscription-configured` compares `consumes`).
- Rules that cover Jonas's list, all the same event, all fetch-shaped middleware: allow-through (no
  rule, or `fetch(request)`), HITL hold (a facet's `fetch` appends `requested`, waits for a signed
  `decided`, then `fetch(request)` and records `released{status}` from the Response it gets back — or
  answers 403), "pipe it through that secret" (a 4-line loaded worker:
  `fetch(new Request(req, { headers: { authorization: "Bearer {{secret:project:X}}" } }))`), deny (a
  403), audit (forward, then append the status), response transforms (forward, rewrite the body),
  mocks for tests (answer without forwarding).
- Hop guard still worth 6 lines: a rule target's OWN bare `fetch()` re-enters the door as a new egress
  (legitimate), and if its own rule matches that fetch it loops across native hops the resolver's
  depth-32 guard cannot see — `x-itx-fetch-hops`, 508 at 8, stripped by the tail.

### D4 Secrets and HITL: the material wall (agents 3, 5, 6)

- MUST be built-in: `itx.secrets.put(name, value, { origins })` + `list()` (write-only; restore the
  write door deleted in cccc4071d — `SECRETS_KV` is read-only today); substitution + origin pin
  checked on the FINAL URL + `redirect:"manual"` as the LAST hop inside `itx.egress`. Userspace targets
  run before it and see placeholders only; the terminal's Response returns to the caller without passing
  any target. A host-rewriting middleware (a prompt-injected agent) gets a 502 with the secret's NAME,
  never a substituted request. Today's clean room has NO pin and follows redirects with custom headers.
- CAN be userspace: rules, deny, batching/debounce/expiry, the approval event vocabulary
  (`approval/requested|decided|released|key-added|key-revoked|rules-configured`), key folds, signature
  verification (WebCrypto over public keys), the CLI, live shadows. The gate is a facet: a `DurableObject`
  class hosted through `itx.load(src).getDurableObjectClass('ApprovalGateDurableObject').get(name)`.
  Since 2026-09-02 a processor host is an ordinary DO class with one `processor` field, so the gate
  can BE a processor host that also defines a `fetch(request)` door: the pure `ApprovalGate extends
StreamProcessor` folds `requested`/`decided` events (unit-tested bare), the host's `fetch` holds the
  request and awaits the decision (`env.ITX.waitForEvent`). No runner, no verb allow-list.
- Signatures: no crypto change. Same `approval.v2` canonical bytes with `projectId → context` (the DO
  name), `approvalRequestEventOffset → requestedAtOffset`, `secretPaths → secrets`. The pure half of
  `egress-approvals.ts` moves to a shared module both the gate bundle and `packages/iterate` import;
  `approve-core.ts` needs only a transport port (`read` + single-type `waitForEvent`, `WAIT_TIMEOUT`);
  `approval-keys.ts` and the Secure Enclave signer are untouched. Once any key is active, policy events
  (`rules-configured`, `key-*`) should be signed too, else loaded code enrols its own key.
- The walls, honestly: (1) a held fetch pins the caller isolate, the entrypoint leg, the DO and the gate
  for the hold and dies with eviction — exactly apps/os; short holds stay transparent, long holds =
  202 + offset + re-issue after `decided` (userspace, unbuilt); the kernel must never promise "a fetch
  survives eviction". (2) Refresh strategies that COMPUTE with material (GitHub App RS256, Waitrose) cannot
  be userspace — defer. (3) Targets never see responses ⇒ no `settled{status}`. (4) KV holds plaintext
  vs apps/os's offset-authenticated ciphertext — Jonas's call. (5) Bodies are not scanned.

### D5 Identifiers: what really collapses (agents 4, 6)

Three root grammars, not eleven families: URL (context paths, DO names, public URLs), expression
(itx expressions, capability paths, stub keys), ad-hoc colon composites (loader keys, kv/secret
prefixes). Every URL-ish identifier ALREADY rides in the expression's ARG slot (`cd('/agents/bot')`,
`kv.get('src/x.js')`, `rpcStubs.get('itx.site')`). So:

- REAL: context path ⇄ DO name ⇄ public URL path share ONE codec (`prj_x.iterate/agents/bot` ⇄
  `https://myproj.iterate.app/agents/bot` is one string apart). The codec defect is FIXED in the onion:
  `resolveContextPath`/`normalizePath` (`context/durable-object-names.ts`) resolve `.`/`..`, the root
  cannot be escaped, and the edge `cd` and the built-in root share the resolver. Left to verify: a
  `cd('.')` to one's OWN path is a self-dial over Workers RPC — harmless, but check it cannot deadlock
  from inside a facet call.
- REAL: "a rule is a stored `?cap=`", and "a hostname label IS a capability-path segment"
  (`itx.apps.<label>`). The DO-name convention survives as one rule kind (`itx.apps.bot ⇒
itx.cd('/agents/bot').apps`), never as automatic path-to-context splitting (contexts are an open
  namespace; only a table can split).
- MUST NOT fold: hostnames into the context's log (directory state); URL paths into dotted capability
  paths (IDENT excludes `1password.com`, `/2024`, `x.css`; DNS is suffix-significant, the walker
  prefix-significant; `/agents/bot/site` has an ambiguous split); expressions into URLs (call chains,
  stubs as args, mid-chain calls). Seductive-but-wrong list in `4-identifiers.md` §6.
- Optional later: bracket-quoted segments (`itx.fetch["https://api.openai.com"]`) for egress rules
  keyed by origin — defer; the `fetch` policy's `hosts` covers it.

### D6 Where each fact lives (C7-consistent)

| fact                                                                                          | owner                                           | store                                                                                                                                        |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| host → projectId, host → app label                                                            | control plane                                   | D1 `routes(host PK, project_id, app)` + platform convention `<app>--<slug>.<base>`; custom domains are Cloudflare-for-SaaS provisioning rows |
| app label → expression                                                                        | the project                                     | ROOT context's capability table (`itx.apps.<label>` mounts)                                                                                  |
| egress policy                                                                                 | the project                                     | `itx.fetch.<name>` mounts with a `fetch` policy                                                                                              |
| secret material + pin                                                                         | physical                                        | `itx.secrets` built-in, read only by `itx.egress`                                                                                            |
| the door + its tail (host decision, substitution, pin, FALLBACK), the WS legs, the stub pager | physical                                        | the one built-in `itx.fetch`; the WORKAROUND fence unchanged                                                                                 |
| "which hosts are ours"                                                                        | control plane, cached in the DO per incarnation | one directory read through FALLBACK (slug, bases, custom-domain rows)                                                                        |
| presence of a tunnel                                                                          | physical                                        | `itx.rpcStubs.list()`                                                                                                                        |
| approval requests/decisions/keys                                                              | the project                                     | userspace events reduced by the gate facet                                                                                                   |

## 3. What dies, what is added

DELETED: the public `/cap?context=&cap=` door (a request with no known host is a 404);
`serveCapabilityFetchLane` (parse → `parseCapabilityFetchHeader` beside the encoder; `PartialFetch`
stays for the two transport doors); `#egress` as a DO method (moved into the built-in);
`DummyControlPlane` + its 2 solo rebinds (`e2e/support/solo-config.ts`, `wrangler.test.jsonc`).
ALREADY GONE (onion): `DEFAULT_CTX`, `?ctx=`, `fetchCap`, the defect-28 self-loop.
KEPT UNCHANGED: `confinedWorker`/the loader cacheKey (rules never enter it), `ItxEntrypoint.fetch`, the
WORKAROUND fence + its delete-day checklist, `isFetchShapedCall`, `expressionEndingInFetch`, `x-itx-cap`
internally, `?context=` as the dev door.
ADDED: host → projectId at the edge (~30 lines; apps/os `decideIngressRoute` minus the OS lanes and
minus the app stamp; `--` forbidden in project ids); the `itx.fetch` built-in = rules walk + own-host
decision (cached directory read: slug, bases, custom rows) + today's `#egress` body as the tail with the
origin pin and `redirect:"manual"` (~110 lines, ~28 of them moved); the door-owned resume header
`x-itx-fetch-below` (stamp, resume-beneath, strip: ~10 lines); the matcher (~40 lines) + its home
(D3: ~60 for a subscriptions-shaped table, 0 for (b), ~10 for (c)); `itx.secrets.put/list`;
`Context.fetch` + `cd(...).fetch` native DO→DO hop (2 lines); `CONNECTION_OFFLINE → 503`; hop guard.
Net src ≈ +110 for two features, ≈ −30 machinery.

## 4. The minimum slice, commit-sized (each green; numbering continues the clean-room C-series)

1. **C8 — ingress by hostname label.** Edge: host → projectId (bases → split the label at the last
   `--`; directory `resolveRoute(host)` with the apex-subdomain fallback when bound; `?context=` dev door;
   `x-forwarded-host` for the harness); strip inbound `x-itx-*`; forward verbatim to the ROOT context;
   unknown host → 404 with no DO wake. DO: the walk's tail gains the own-host branch (label →
   `resolveFetch(["itx","apps",label], request)`, no mount ⇒ 404; the host list = slug + bases + cached
   directory rows; solo: slug = id, base = own host). Delete `/cap`. Re-point the four
   `e2e/fetch-door-*.e2e.test.ts` files (cap-http-and-websocket, dynamic-live-ws, tunnel-to-localhost,
   egress-missing-secret-502) to `provide('itx.apps.site', …)` + a labelled host; the 502 file drives
   the tail through a dynamic worker's `globalOutbound` to an external host instead of the public door
   (that IS the assertion). **This alone delivers `iterate tunnel site
3000` at `https://site--myproj.iterate.app/` with WebSockets.**
2. **C9 — `iterate tunnel <label> <port>`** in `packages/iterate` (`connectItx` + the tutorial's `Tunnel`
   - `keepMountAlive` from `use-my-computer.ts`; revoke by offset on exit; prints every host). Needs the
     clean room on a wildcard zone to be useful off workers.dev.
3. **C10 — `itx.fetch` is a built-in.** Move `#egress` behind `builtIns.fetch` as its tail (+ origin
   pin, `redirect:"manual"`, `itx.secrets.put/list`); the DO's native fetch ends in
   `this.invoke(["itx", ["fetch", request]])`; declared `IterateContext.fetch`; `FALLBACK` optional;
   `DummyControlPlane` dies. Harness 502 tests unchanged.
4. **C11 — rules as middleware.** The matcher's home per D3 (recommended: the `fetch-rules` table +
   inline reduce), the rules walk inside the built-in before the host decision, the
   `x-itx-fetch-below` stamp/resume/strip, hop guard. Tests: a catch-all loaded-worker wrapper that forwards reaches the tail
   exactly once (no loop); an auditing wrapper sees the upstream status; a WS 101 through a wrapper;
   two matching rules → newest; a wrapper that drops the stamp → 508. Every existing header-lane test
   unchanged.
5. **C12 — `cd(...).fetch` is a native DO→DO fetch hop** (sub-context apps with WebSockets).
6. **C13 — the approval gate** (userspace facet + shared pure module) and the `iterate approve`
   transport port. **C14 — `itx.auth` built-in.** **C15 — control plane:** owner-checked `upsertRoute`
   (today's `ON CONFLICT(host) DO UPDATE` is a silent last-writer steal), slug existence check so a
   scanner's 404s stop waking virgin DOs, custom-hostname provisioning.
7. DEFER: KV-mirrored rules evaluated in `ItxEntrypoint` (DO-free egress for terminal-bound fetches —
   the strongest long-term argument FOR rules-as-data, and exactly the speculative machinery to not
   build now; measure DO duration first); bracket segments; body scanning; the 202 long-hold tier.

Tutorial edits ride C8–C11 (`docs/tutorial-build-the-iterate-context.md`, rewritten in the onion but
still teaching `/cap` in Chapter 2): Brick 7 becomes one DO `fetch` + `globalOutbound: host` in Brick 5;
Chapter 2 becomes six short sections ("one door", "the terminal", "the hostname label names the capability", "the
tunnel is one provide", "a rule is a mount", "human in the loop is a rule plus two events") — outline in
`6-tutorial-adversary.md` §A.2, with the claims that go false (the `/cap?ctx=&cap=` headline, "the edge
resolves", "strangers can reach your context", "hot reload and all" — today's `/cap` door hands the
tunnel a polluted path, the proof harness records `upstream-saw:GET /cap?ctx=…`) in §A.3.

## 5. Risks and open decisions for Jonas

- **D3 is reopened** (above): the matcher's home — a subscriptions-shaped table (recommended), no
  matcher in data, or a policy on the mount against the onion's doctrine. This decides how much of
  "rules are data" survives. Everything else in this plan is independent of the pick.
- **`itx.apps.<label>` vs root-level `itx.<label>`** — recommended `apps.` (explicit exposure; no
  built-in-name collisions). One-line decision.
- **Who derives the app label: the door (from the request host + the cached host list) or the edge (a
  trusted stamp)?** Recommended the door, with the edge's stamp at most a cache — one place understands
  "internal", and a worker fetching its own project's app short-circuits in-DO.
- **The resume stamp is a door-owned header on the Request.** A trusted-but-buggy worker can drop it
  (508 after 8 hops) or forge a low offset (skips rules — trusted clients, no defense by doctrine). The
  alternative — a `next` callable passed as an argument — is out because it would return Responses over
  RPC and break every WebSocket upgrade through a wrapper.
- **Every known-host request wakes the ROOT DO** (unknown hosts never do). Same shape as apps/os's
  DO-duration incident; the edge KV mirror is the documented, unbuilt escape.
- **Outbound WebSockets through the door pin the DO ≤15 min/connection** (the voice case) — unmeasured
  whether a FORWARDED 101 counts. Measure in C10's tests before believing.
- **Newest-wins has no specificity metric** — a catch-all provided after a specific rule shadows it;
  same surprise as a late default mount today.
- **Native dynamic-worker providers still cannot answer a 101** on the live lane (pre-existing
  `test.fails`); a label pointing at one is HTTP-only until the dial-back lands.
- **Plaintext secrets in KV** (a downgrade from apps/os's ciphertext) — ~40 lines to encrypt-in-put /
  decrypt-in-terminal if wanted, still inside the built-in.
- **`/api` on a custom apex** — the project's or the app's? apps/os gives it to the app.
- **The edge stamping model is trusted-client only**: a dynamic worker can set `x-itx-cap:
itx.apps.site` on its own egress and reach the app from inside (today's feature); harmless by doctrine.

## 6. The jam — the trade-offs and philosophical questions (2026-09-02)

**Q1 — Is a fetch rule a subscription?** Structurally, yes: `{ name, target, filter }`, evaluated
before the target is called, newest wins, revocable by name, folded by an inline reduce, read through
a list. The onion made subscriptions their own layer for exactly this reason (a filter is not a
mount). Following it gives rules a third small table and keeps mounts pure; refusing it means either
policy back on mounts (c) or a hop per rule per request (b). The deeper question: is a _request_
enough like an _event_ that the two tables should be ONE (`itx.subscribe({ target, consumes:
["fetch/*"] })` with a request-shaped payload)? Probably not — a request needs an answer and a
subscription never answers — but it is the question that decides whether "rules" is a new noun.

**Q2 — Where does "next" live: in the request or in a capability?** D2 puts the walk position in a
header the door owns (`x-itx-fetch-below: <offset>`), so forwarding is just fetching the same request
again: 101-safe, no new noun, but trusted-client only (a wrapper that rebuilds the Request drops it; a
forged low offset skips rules). The alternative — a `next` capability handed to the rule — is cleaner
to reason about and impossible here (a Response over RPC cannot carry a socket). The trade is
"the request carries its own position" vs "the platform hands you a continuation".

**Q3 — One root or many rows?** Everything could be a shadow stack on ONE path: `provide('itx.fetch',
gate)` shadows the built-in root, newest wins, each shadow forwards beneath itself. It is the most
onion-like spelling (a rule is a mount that shadows a built-in) and needs no matcher, but: by-name
resolution is BUILT-IN FIRST today (a mount at `itx.fetch` is never reached by name), the native door
(globalOutbound, the edge) would have to consult the stack, and every request pays every shadow.
Named rows with a matcher are the pragmatic middle.

**Q4 — Who decides direction, and when?** The tail decides by the request's host, from a cached
directory read (the DO takes a dependency on the control plane's host list for the incarnation). The
edge could stamp the label instead. One place understanding "internal" wins on clarity; the cost is a
directory read per incarnation and a wake of the ROOT DO for every known-host request.

**Q5 — Is exposing the same act as providing?** `itx.apps.site` as a mount says yes: a public route
is a capability like any other, revocable, replayable, shadowable. `itx.apps.<label>` vs root-level
`itx.<label>` is the only spelling question left (explicit exposure vs one fewer segment).

**Q6 — What MUST be physical?** Secret material and its origin pin, the 101-carrying channels, the
stub pager. Everything else in the request path can be userspace fetch-shaped targets. Plaintext KV
vs ciphertext, body scanning, and the 202 long-hold tier are the honest gaps; "a fetch survives
eviction" is a promise the kernel must never make.

**Q7 — Is the approval gate a processor?** With the split, a processor host is a DO class that may
carry a `fetch` door: `ApprovalGate extends StreamProcessor` folds the approval events (pure,
unit-tested), `ApprovalGateDurableObject` hosts it and holds requests. That makes "human in the loop"
a rule whose target is a processor — events are the interface, the hold is a facet call. The question
is whether a held fetch pinning the gate facet (≤ the delivery watchdog) is acceptable, or whether the
long-hold tier must exist from day one.

**Q8 — Which slice first?** The plan says ingress (C8) first because it delivers `iterate tunnel`.
With the control-plane directory not yet wired, the shortest honest first commit is C10 + C11 (the
built-in's walk in front of today's tail, plus rules), all provable in solo; C8 then adds the
own-host branch to a walk that already exists.
