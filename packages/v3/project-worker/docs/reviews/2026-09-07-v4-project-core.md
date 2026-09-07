# `packages/v3/project-core*` reviewed against the v3 clean room

Read-only review of the three untracked sibling packages beside `packages/v3/project-worker`. Counts
are measured: "code lines" = non-blank, non-comment; "raw" = `wc -l`, what `scripts/size.ts:14` counts.

## 1. What project-core is

**`packages/v3/project-core`** — "an independent experiment beside `../project-worker`, based on the
September 4 brief" (`README.md:3`): a whole second project kernel written from scratch under a hard
**<5,000 raw implementation lines** budget enforced by `scripts/size.ts:23` (exit 1 at ≥5000). Measured:
**2,837 code lines in `src/`** across 17 modules; **3,799 raw** implementation lines (`src/` + `public/`
+ config + scripts — exactly the README's figure); **2,292 raw** E2E; plus 10,521 lines of `notes/` +
`evidence/` + design docs the counter deliberately excludes.

Modules: `worker.ts` 632 · `egress.ts` 400 · `lending.ts` 325 · `stream.ts` 237 · `repositories.ts` 155 · `processors.ts` 155 · `auth.ts` 149 · `signatures.ts` 124 · `routing.ts` 116 · `runtime.ts` 109 · `model.ts` 99 · `mcp.ts` 96 · `types.ts` 86 · `bundler.ts` 69 · `build.ts` 41 · `ingress.ts` 29 · `encoding.ts` 9. v3 for scale: ~5,300 non-test code lines, 44 non-test `src/` files.

**The API it proposes** — v4's README calls it "the replacement member-array API", exactly right:

```ts
abstract class ScopeTarget extends RpcTarget {   // src/types.ts:99 — `build: BuilderTarget` too
  cd(path: ContextPath): ScopeTarget;   fetch(r: Request): Promise<Response>;
  invoke(path: readonly string[], ...args: unknown[]): Promise<unknown>;   // the one escape hatch
  append(in: EventInput | readonly EventInput[]): Promise<readonly EventRecord[]>;
  readEvents(o?: ReadEventsOptions): Promise<EventPage>;   inspect(): Promise<ContextInspection>;
  load(code: WorkerInput, exportName?: string): Promise<WorkerTarget>;
  provide(match: string, target: MountDescriptor | LentCapability): Promise<HandleTarget>;
  subscribe(cb: StreamCallback, o?: SubscribeOptions): Promise<HandleTarget>;
}
```

The address is `project id + context path`; `builtins` is the unrewritable physical root and short
dotted names resolve by **longest `mount/<dotted-prefix>` setting**, with a 16-hop guard. A dotted facade
is *proposed only* and must compile to `invoke(["x","y"], …)`. `ARCHITECTURE.md` "Deliberate differences
from the predecessor" is candid that it has **no** rewrite grammar, argument templates/masks, inspection
surface or automatic live-mount revocation.

**Deployment.** `wrangler.jsonc` — `iterate-project-core-experiment-preview` on dev-preview account
`376ef7ed…`: `worker_loaders: [{binding: LOADER}]`, DO `Context` (sqlite), `OAUTH_KV`, `ASSETS` with
`run_worker_first`, a `BUNDLER` service binding, and ingress **vars** `PROJECTS` / `CUSTOM_HOSTNAMES` /
`PROJECT_HOSTNAME_BASE`; `wrangler.bundler.jsonc` is a separate stateless bundler with a `BUILD_CACHE`
KV. `deployment.ts` (19 lines) is the isolated **production-account** domain proof: account
`04b3b572…`, `iterate-project-core-domain-poc` (+ bundler), origin `https://iterate2.com`,
`customHostnames: {"iterate.computer": …}`, four zone routes incl. `*.iterate2.com/*`; claim: version
`f0032a5a-…` passed **44/44** public tests in 38.2 s. **`evidence/`** is 30 dated records (5 September),
each a public-seam measurement with exact versions/timestamps and explicit "not deployed acceptance"
caveats — e.g. `live-reader-fairness.md` (p99 live lag 1.3 s at 16 writers → 7–8 ms with a reader-aware
yield, at ~27 % lower write throughput).

**`packages/v3/project-core-fetch`** — a bounded fork asking "can the project core be one portable
`fetch(Request) → Response` with three durable verbs?". **135 code lines** (`src/core.mjs` 102,
`node-server.mjs` 29, `node-source-runner.mjs` 4) + 53 E2E; no wrangler config, no deployment, Node
only; it answers its own question in the negative and says so.
**`packages/v3/project-core-ws-probe`** — a diagnostic-only Worker, **664 code lines** in
`src/worker.ts` + 240 in three drivers, deployed as `iterate-project-core-ws-probe-b6f58624` with nine
named entrypoint exports and a `ProbeContext` DO. Its 410-line README is a chain of ~14 one-variable
deployed A/Bs read back through Cloudflare's telemetry query API.

## 2. Ideas worth taking into v3

**(a) The egress terminal's three hardenings — origin pin, secret revision, atomic one-shot claim.**
v3's whole egress is 34 code lines (`packages/v3/shared/src/egress.ts`) plus ~22 in
`src/iterate-context-durable-object.ts:819-845`: substitute `{{secret:project:NAME}}` in headers, then
`env.FALLBACK.fetch`. Secrets are unversioned in `SECRETS_KV`, with **no write door** (Gap 7, open).
project-core `src/egress.ts` adds three things v3 has no answer for: a **canonical HTTPS origin stored
with each secret**, so a leaked placeholder cannot be replayed at another host; a **revision**, so
rotation is encrypt-then-CAS and a race is `SECRET_CONFLICT` not a lost write; and a terminal doing
*freshness recheck → atomic claim → native fetch with no intervening `await`*, leaning on DO output-gate
ordering to persist the claim before the request leaves (`notes/egress.md`). The third is genuinely new
and small. Take these into `shared/src/egress.ts` and `#egress`; leave the rest.

**(b) `itx.builtins.repos` — immutable file-map commits, CAS'd head, one transaction.**
`src/repositories.ts` is **155 code lines** and closes most of Gap 3 ("no file tree, no repo, no git",
`docs/assessment-userspace-apps-on-the-clean-room.md:195`). Minimal and doctrine-compatible:
`repo.commit` is an ordinary event, the revision derives from canonical `{files, parent, message}`,
blobs are immutable, and the named head is CAS'd **inside the same append transaction**. It passes the
litmus test one-way only — userspace could keep a file map but could *not* make the head CAS atomic with
its own append — so it belongs beside `kv` in `built-in-roots.ts` / `built-ins.ts`, not `src/library/`.
Better than any v3 spelling because v3 has none.

**(c) The MCP *server* door, as a library verb.** `src/library/mcp.ts` (174 code lines) is a
**client**; nothing serves a project *as* an MCP server, and `src/` has zero OAuth. project-core
`src/mcp.ts` is a 96-line stateless Streamable-HTTP adapter mapping one `iterate` tool onto configured
capability methods, proved by a real authorization-code/PKCE exchange (`e2e/mcp.test.ts`, 158 lines). A
server written against `itx` alone passes v3's library litmus test cleanly: `src/library/mcp-server.ts`,
reached by a rewrite rule on a project host. The OAuth *authorization server* half (`auth.ts` +
`@cloudflare/workers-oauth-provider`) is control-plane work.

**(d) `CUSTOM_HOSTNAMES` as the shape of the custom-domain hole.** v3 closed Gap 1 on 2026-09-06 with
`<label>--<projectId>.<base>` ⇒ `itx.apps.<label>` (`src/project-host.ts`), and the assessment records
the exact remainder: "**still missing from this gap as written: pretty slugs and custom domains**
(directory rows, the control plane's)" (`docs/assessment-...:111-115`). `src/ingress.ts` (29 lines) is a
working sketch of that row: an exact registered domain wins over its one-label subdomains, and
`docs.customer.example` derives the app label. Take the **shape**, not the deployment var (§3).

**(e) `subscribe(callback, { afterOffset })` — replay from an offset.** Gap 6 says a v3 client
re-implements long-poll and replay itself because "`subscribe` has no `replayAfterOffset`"
(`docs/assessment-...:283`). project-core's `SubscribeOptions = { afterOffset?: number }`
(`src/types.ts:15-17`) is that one field, its stream already pages/acks from it (`stream.ts:194`), and
~15 lines in `src/stream/subscriptions.ts` + `subscription-delivery.ts` would do it.

**(f) An enforced line budget.** `scripts/size.ts` is 23 lines and exits non-zero over the cap; v3 has
**no** counter — every LOC figure in `BUILD-LOG.md` and `docs/itx-surface-as-built.md:514-544` is
hand-recounted (§11 warns "Recount rather than trust it"). The only mechanism in either tree making
"radical simplicity" falsifiable.

Deliberately **not** here although tempting: the reader-aware fairness yield and the 20 s ACK lease.
`src/stream/subscription-delivery.ts` (460 code lines) already solves the stalled reader differently and,
I think, better — a per-row and global **pending-push char budget**, so "a stalled client blocks nothing
but itself" (`:46-62,404`) — not by leasing one of a fixed 64 slots.

## 3. Ideas to reject, and why

**The member-array API itself.** `invoke(path: readonly string[], ...args)` takes args only at the
*terminal* step. v3's `ItxExpression` is already a member array —
`type ItxExpressionStep = string | [method, ...args]` (`src/context/expression.ts:13-16`) — with args
at **every** step, which is what makes mid-chain pipelining (`itx.a.b(x).c(y)`) work, a property v3 has
proved. project-core's surface is strictly less expressive, and its `ARCHITECTURE.md` admits the dotted
facade it wants must compile to `invoke()` anyway. Taking it would be a regression.

**The `mount/fetch` policy *worker*.** project-core makes routing an installed executable Worker that
alone receives `env.NEXT`, selecting `{kind:"worker"|"network"}` destinations. Direct collision with
v3's landed doctrine that **mounts carry no policies** and the rewrite-rule table is the one place a
target is named (`docs/plan-one-fetch-rules.md`, 2026-09-02 re-alignment: capability-table 5.0.0 is
`{path, target}` "and nothing else"). It also re-introduces the executable-configuration hop v3
deleted. Take the *terminal* (§2a), not the policy.

**Plural Ed25519 provenance and trust levels.** `src/signatures.ts` (124 lines) verifies up to 16
signatures per event and lets a `trust` setting **reject** an unsigned append at levels 1/2 — identity
as *authority*, contradicting v3's trusted-client doctrine and its 2026-09-06 decision that the
principal is attribution stamped on `source` (`src/stream/events.ts:19-28`; BUILD-LOG:3628 — "the
principal IS an event `source`, never `metadata`, which is the client's"). The useful half —
separating signed claims from platform observations — is already that `source`/`metadata` split.

**`project-core-fetch` as an architecture** — see §4; a good null result, nothing to port. Likewise
**`provide()` / `lending.ts` / `processors.ts` / `stream.ts`, `ContextInspection`, the eight-page
tutorial UI** (`public/`, 293 lines): re-implementations of things v3 has in more developed form
(`rpc-stub-directory.ts` 251 + `rpc-stub-relay.ts` 154, `stream/processor.ts` 334, `stream.ts` 453,
`docs/tutorial-build-the-iterate-context.md`, `/demo`). `notes/lending.md` says so itself: "The
independent evidence for the protocol is the existing clean-room implementation."

## 4. What the two probes found

**`project-core-fetch`**: the seam `append`/`read`/`subscribe` fits `fetch` cleanly in **102 lines**;
callbacks, capabilities and confinement do not, without restoring a session-capability layer — "a URL …
does not carry an arbitrary object capability, object identity, revocation semantics, promise
pipelining, or a callback that the server can invoke later", SSE has no durable ack or callback return
value, and `new Function` is forbidden on Workers so its dispatch demo does not port. **v3 accounts for
this** implicitly — it never tried to be fetch-only.

**`project-core-ws-probe`** found a real, reproducible platform hazard that **v3 does not account
for.** Minimized: a **named** `LOADER.get(id, getCode)` whose loaded child either returns a WebSocket
upgrade *or* fetches through an injected `globalOutbound` produces native `exception` / `canceled`
telemetry rows even though every client assertion passes; `LOADER.get(null, …)` is clean in both
cases; `LOADER.load()` is clean; and `new Response(response.body, response)` does not repair it. It
also found that an **undisposed returned RPC capability** turns an otherwise-successful
`CapabilityHost.jsrpc` row `canceled`, and that disposing the settled call promise (for known-inert
plain data) turns 20 canceled rows into 20 ok. Every claim is a dated deployed A/B with trace IDs.

This bears on v3 directly: `src/context/worker-loader.ts:194,227` is exactly the red shape —
`opts.env.LOADER.get(loaderId, …)` under a **named** cacheKey with `globalOutbound: opts.itxEntrypoint`.
v3's fetch doctrine (`src/fetch/rpc-stub-fetch.ts:1-31`, 137 code lines) is about *serialization*
(`DataCloneError`), not lifetime telemetry, and the BUILD-LOG's nearest disposal entry is edge#13
(`:3457`, a disposed capnweb dup re-coded `RPC_STUB_OFFLINE`) — a different problem. **So the finding
is unaccounted for in v3, and v3 is in its blast radius.** What it does *not* establish is
user-visible harm: every probe exchange returned correct bytes.

### The four root-level research docs

**`docs/native-rpc-fetch-lifecycle-research.md`** establishes that v4's `rpc-stub-fetch.ts` must
**not** become an ordinary native Workers-RPC method today: in workerd `c4e03fa1d`, response
serialization rejects `Response.webSocket` (`http.c++:1351-1379`), so the relay→DO return leg throws
`DataCloneError` for a 101; Cap'n Web 0.12.2 carries an upgrade over *its* session, so capnweb is no
longer the blocker but the native hop is. It adds four exit criteria for deleting the workaround and an
inconclusive note on disposing inert call promises. **v3 depends on this being true** —
`rpc-stub-fetch.ts:20-31` states the same two facts as doctrine point 4 and fences the module as a
delete-day workaround; `:136-144` records that "a NATIVE provider's socket answer still dies on its own
RPC leg". It confirms v3's fence and exit condition; nothing in v3 changes.

**`docs/v4-native-websocket-close-repro.md`** establishes a *v4* release gate: on deployment
`0b689aaa`, a loaded worker's `/expression` upgrade returns 101, echoes and closes 1000 correctly, while
the parent/DO native spans report `exception` with **empty** `exceptions`/`logs` arrays (trace
`32abc32a…`). It rules out `web_socket_auto_reply_to_close` and the known-benign
`responseStreamDisconnected` outcome, offers a source-backed double-report hypothesis, and refuses to
call it harmless. **v3 does not depend on it but is exposed to the same condition** — it is the signature the ws-probe minimized to named-loader-cache + upgrade, and v3 uses that combination.

**`docs/wrangler-local-body-upgrade-research.md`** establishes that a purely **local** Wrangler/
Miniflare failure — a finite chunked `POST /api` classified 413, then a later upgrade getting HTTP 500
`Network connection lost.` at cycle 21–23 — is an upstream tooling problem (workers-sdk #15203,
unmerged PR #15207), differential on the `assets` configuration, located at the outer ProxyController
hop rather than the assets pipeline, with KJ pooling/timeout defaults verified but **not** shown causal.
Explicitly "parked at the owner's direction; V4 acceptance concerns deployed behavior only". **v3 does
not depend on it** — its local-lane limits are different (`BUILD-LOG.md:3299`: workerd's fetch proxied
through Node's answers an Upgrade with "TypeError: fetch failed", so WebSocket e2e are `skipIf(local)`).
Keep the note in case a v3 local lane grows a body-bearing POST loop.

**`docs/preview-proof.md`** (1,096 lines) is **v4's** versioned deployment record — thirteen numbered
deployments with version IDs, UTC windows, test counts (v13: 85/85 public matrix, 4/5 resource matrix,
one classified DO reset) and named open gates. It mentions project-core **nowhere** (grep: zero hits).
**v3 does not depend on it**; its value to v3 is the deployed-evidence format and the confirmation that
the 144 MiB read-reset class d3 chased in v3's memory-budget arc also reproduces in v4.

## 5. Effort

Against project-core as the upper bound, at v3's density (~300 code lines with tests, docs and a deployed proof in ~3 h):

| Item | project-core LOC | v3 estimate | Hours |
|---|---|---|---|
| (a) egress: origin pin + revision CAS + atomic one-shot claim | subset of `egress.ts` 400 | 120–160 code + ~80 table/unit + 1 deployed e2e | 4–5 |
| (b) `itx.builtins.repos` root (commit/head/read, CAS in the append txn) | `repositories.ts` 155 | 150 code + a `{files,parent,becomes}` table + 1 deployed e2e | 3–4 |
| (c) `src/library/mcp-server.ts` (server half only) | `mcp.ts` 96 | 110 code + unit + 1 deployed e2e | 3–4 |
| (d) custom-domain directory row (shape only; needs the control plane) | `ingress.ts` 29 | 40 code in `project-host.ts` + table rows | 1–2 |
| (e) `subscribe({ afterOffset })` replay | part of `stream.ts` 237 | ~15 code + 1 unit + 1 e2e | 1 |
| (f) a `size` script | 23 | 25 | 0.5 |
| (g) reproduce the ws-probe's red against v3's loader | probe 664 (do not port) | ~0 code, 1 diagnostic run | 2 |
Everything in §3 is 0 hours by decision.

## 6. Dependencies

- **(a) egress** needs a secrets **write door** (Gap 7) first — v3 has no way to put a secret, so an
  origin pin has nothing to pin. Then independent; it unblocks the connectors against real third-party APIs with rotatable credentials.
- **(b) repos** is fully independent (`built-in-roots.ts` + `built-ins.ts` + one module). It unblocks
  Gap 3's remainder (workspace overlay, repo-backed config) and a `{repo, revision}` source form.
- **(c) MCP server** needs only a rewrite rule and a project host — both landed 2026-09-06; the OAuth
  authorization server it was proved with is **not** a dependency. **(e)** is independent and smallest.
- **(d) custom domains** is blocked on the control plane's directory row, a wildcard DNS record per
  domain, and a zone/route per domain — infrastructure v3 does not own. Blocked on Jonas, not code.
- **(g) the telemetry check** should run *before* (a)–(c): if the named-loader-cache hazard is real
  user-visible harm it changes `worker-loader.ts`'s cacheKey strategy, which everything loaded sits on.

## 7. Risks and questions for Jonas

1. **Is an approval/HITL gate in scope at all?** project-core spends much of `egress.ts` on one-shot,
   fingerprint-bound human approvals; v3 has zero occurrences of "approval" in `src/`. The
   trusted-client doctrine says no malicious-client defence — but an approval gate defends against a
   *confused agent*, not a malicious client. Different threats. If in scope, only the atomic claim
   belongs in the platform; the request/grant vocabulary is a userspace processor.
2. **Do we want a second identity axis?** project-core's trust levels can reject an append; v3 decided
   identity is attribution. I recommend holding that line — but "a security upgrade is an ordinary
   co-signed fact" (`INTERESTING-IDEAS.md` §1) is a good product idea if a project should ever be able
   to lock itself down.
3. **Custom domains: deployment var or event?** project-core puts `CUSTOM_HOSTNAMES` in
   `wrangler.jsonc` vars. Fastest, but it conflicts with "events are the interface" and with v3's
   decision that this is a control-plane directory row. Which side wins?
4. **An enforced line budget, at what number?** v3 is ~5,300 non-test code lines across 44 `src/` files; project-core's <5,000 raw cap produced its terseness — and, visibly, its missing features.
5. **Unverified claims.** I ran nothing: "44/44 in 38.2 s against `iterate2.com`", every version ID and
   timestamp in `evidence/`, and every ws-probe trace ID are asserted by those documents, not confirmed
   here. The one thing I verified by measurement is the size budget — 3,799 / 2,292 raw lines, as stated.
6. **The isolated production account.** `deployment.ts` names account `04b3b572…` with live routes on
   `iterate2.com` and `iterate.computer`; `wrangler.jsonc` names dev-preview `376ef7ed…`; the ws-probe
   holds a third. None is in the root `envs.ts`; somebody should decide whether these experiment workers and their four zone routes get torn down.
