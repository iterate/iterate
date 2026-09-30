# Sweep candidates: os-do-core

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## Make urls.os required: the platform origin stops travelling six ways for one unconfigured self-host

- Sweep index: 0; risk: medium; payoff: 6/10
- LOC: About −200 in total, measured from the cited ranges.

Product, about −115:

- context DO: −49
- built-ins.ts: −26
- stateless-context.ts: −10
- rpc-stubs.ts: −8
- worker-loader.ts: −7
- app-config.ts: −5
- caller.ts and github.ts: −4 each
- others: −6

Tests, about −85:

- the integrations.test.ts self-host row (1476-1498) and its helper (1714-1745): about −55
- worker-loader.test.ts: −12
- the no-urls.os half of worker.test.ts: about −12
- stubs: −6

Docs: setup-prompt.md +1. (skeptic measured: Measured at b3daf4846 with sed and wc on the cited ranges.

- Context DO: 43 lines in the deleted ranges, +3 for the new getter and about −6 scattered lines, so about −46.
- built-ins.ts: the five refusals are 23 lines, and the deps field and comments bring the file to about −28.
- Other product files: stateless-context about −10, worker-loader −7, rpc-stubs −8, caller −4, facet-host −2, github.ts/verbs.ts about −6, app-config about −6, and worker.ts about −10 if the http redirect goes.
- Product total: about −120 to −125.
- Tests:
  - integrations.test.ts: the 24-line self-host row and 34 lines of helper and const, about −58.
  - worker-loader.test.ts: about −13.
  - worker.test.ts: about −12 net, after MINIMAL gains urls.os.
  - Smaller: oauth.test.ts +1; rpc-stubs.test, rpc-stub-pager-attach and facet-host.test about −6.
- Tests total: about −80.
- Docs: setup-prompt.md +1, plus comment fixes in generate-wrangler-config.ts:205 and SELF-HOSTING.md.
- Net: about −200.

Shipped alone, the double-memo step is about −7 lines with identical semantics.)

- Concepts: 7 carriers become 1.

Before:

- the Caller field
- the header
- the entrypoint prop
- the learned kv value and its field
- the loader-id element
- a second stub memo
- a 'no origin yet' state with 5 error branches

After: appConfig.urls.os, always set.

### Evidence

Merges three rows: the parallel and heavy hunts' urls.os rows, and the routing hunt's double-memo row. Line numbers are as of cfd8a1d36; #3442 has since touched the DO and worker-loader.

The config and its fallback:

- apps/os/src/app-config.ts:170 declares `os: optionalOrigin` ('Blank ⇒ each request's own origin').
- app-config.ts:612 falls back with `config.urls.os || new URL(request.url).origin`.

Every deployment already names the origin:

- scripts/generate-wrangler-config.ts:28 (prd and every preview) and :176 (local)
- wrangler.test.jsonc:12
- e2e/support/worker-config.ts:62
- Only selfHostWranglerConfig (:210-240) leaves it blank, and public/setup-prompt.md:54 already derives the origin (`GET /workers/subdomain`).

Where the origin is carried:

- caller.ts:35-38 `Caller.platformOrigin`
- context/rpc-stubs.ts:501-506 and :538 (`x-itx-platform-origin`)
- iterate-context-durable-object.ts:
  - :271-287 `#platformOrigin`, plus `#itxEntrypointStub`, a second memo in front of itxEntrypointFor's WeakMap at stateless-context.ts:135-162
  - :448-453 kv `platform-origin`
  - :1643-1661 `#withPlatformOrigin`, wrapped around 8-9 call sites
  - :1749-1752
- iterate-context.ts:583 and :656 (ItxEntrypoint prop)
- stateless-context.ts:47, 66, 84, 116, 135-162, 177, 187
- worker-loader.ts:177-194 and :337-350 (the origin is part of the loader id)
- built-ins.ts: five 'no platform origin — call it from a session' throws, at :1226, :1425, :1737, :2154 and :2296.

In total, git grep finds 199 platformOrigin references in apps/os/src.

### Current shape

The origin that URLs are built from is urls.os, or each request's own origin when urls.os is unset. It is carried as a Caller field, as a header, as an ItxEntrypoint prop and as part of the loader id. Each context also learns it and persists it in kv. On prd, the previews, dev and tests, every one of these carriers always holds appConfig.urls.os. Only a self-host with a blank urls.os can reach the 'no origin yet' state, which five built-ins refuse.

### Proposed shape

```ts
// app-config.ts
os: origin, // was optionalOrigin; drop the `urls.mcp needs urls.os` check
// iterate-context-durable-object.ts
get #itxEntrypoint() { return itxEntrypointFor(this.ctx, this.#durableObjectAddress.name); }
// built-ins / stateless-context / facet-host deps
const platformOrigin = appConfig.urls.os; // a string, never null
// public/setup-prompt.md step 4
APP_CONFIG={"urls":{"os":"https://iterate.<subdomain>.workers.dev"},"login":…}
```

Delete:

- Caller.platformOrigin and ITX_PLATFORM_ORIGIN_HEADER
- #platformOrigin, #withPlatformOrigin (its call sites pass the caller unchanged) and the kv row
- #itxEntrypointStub, `withOrigin`, and the origin element of the loader id
- the five refusals

The double stub memo can ship first on its own: `#itxEntrypoint = itxEntrypointFor(ctx, name, #platformOrigin)` removes about 7 lines with identical semantics.

### What changes

A deployment must set urls.os: a blank one fails APP_CONFIG parsing at boot. The recipe already knows the value at step 3. The one live self-host (iterate.templestein.workers.dev) adds the line before its next deploy.

A self-host reached on a second hostname builds URLs on urls.os, as prd already does.

On a blank self-host, itx.url, files.presign, secrets.beginOAuth, secrets.collectFromUser and integrations.connect stop refusing from alarms and loaded code.

Loader ids change once, so each loaded facet restarts once with its storage kept. Every deploy already does this.

Nothing changes for prd, the previews, dev or tests.

### Pinned by

- src/worker.test.ts:46 and :547 (`/version` falls back to the request origin)
- **workers-tests**/integrations.test.ts:1476 (GitHub on a deployment with no urls.os) and githubScopeWithoutUrlsOs at :1718
- src/context/worker-loader.test.ts:490 and :525 (the origin is part of the loader id)
- src/context/rpc-stubs.test.ts:31, 46 and 54
- **workers-tests**/rpc-stub-pager-attach.test.ts:98-105
- src/context/facet-host.test.ts:115
- src/context/stateless-context.test.ts:5-16 (the memo)

### Skeptic's amended proposal

Two steps, in one PR.

**Step 1 (identical semantics):** replace the DO's `#itxEntrypointStub` memo with a getter.

```ts
get #itxEntrypoint() { return itxEntrypointFor(this.ctx, this.#durableObjectAddress.name, this.#platformOrigin); }
```

`itxEntrypointFor` already memoizes per ctx and origin.

**Step 2:** make `urls.os` required.

- In app-config.ts, set `os: httpOrigin`. Drop the `urls.mcp needs urls.os` check (:449-452) and the `if (!origin)` line in `isPreviewOrLocalOrigin`.
- Built-ins, the stateless resolver, facet-host and workersRoot read `appConfigOf(env).urls.os`, a string. The `platformOrigin: () => string | null` deps go.
- Delete these carriers:
  - `Caller.platformOrigin` and `ITX_PLATFORM_ORIGIN_HEADER` with its strip and read;
  - the `ItxEntrypoint` prop `platformOrigin`;
  - `#platformOrigin`, `#withPlatformOrigin` and the kv row `platform-origin`;
  - `withOrigin` and `callerThere` in stateless-context;
  - the `platformOrigin` argument of `itxEntrypointFor`, which becomes `(ctx, name)`;
  - the origin element of the loader id;
  - the five no-origin refusals;
  - GitHub's `platformOrigin` input and its shape check, since github.ts reads config.
- Delete the blank-origin http→https redirect (worker.ts:273-280), or keep it as a two-line redirect to `urls.os` when `https://${url.host} === urls.os`.
- Docs:
  - setup-prompt.md step 4 writes `APP_CONFIG={"urls":{"os":"https://iterate.<subdomain>.workers.dev"},"login":…}`, using the origin step 3 found.
  - generate-wrangler-config.ts:205 and SELF-HOSTING.md drop "urls.os stays unset".
- Tests:
  - MINIMAL and MINIMAL_CONFIG in worker.test.ts, and oauth.test.ts:126, gain urls.os.
  - Delete the integrations.test.ts self-host row and helper, the worker-loader "origin in the loader id" row, and the /version fallback half.
- Decide explicitly on the `isPreviewOrLocalOrigin` guard, which a self-host's workers.dev origin now passes. Either accept it, since the self-host operator is trusted and the guard's stated target is prd, or narrow it to `*.iterate-dev-preview.workers.dev` in one line.
- Before its next deploy from main, the live self-host sets `urls.os`.

Leave the issuer-side `platformAddressesOf(env, request)` signature alone in this PR.

### Skeptic's verdict

The central claim holds against the code at b3daf4846, which already includes #3446 and #3442. #3446 does none of this; it only adds a `platformOrigin: () => null` test stub.

**Every deployment we run already sets urls.os**

- generate-wrangler-config.ts:25 sets `APP_CONFIG_URLS__OS: env.baseUrl` for prd and every preview. Local dev and the local build set it at :176, wrangler.test.jsonc:12 sets `https://control.test`, and e2e sets it at worker-config.ts:62.
- `platformAddressesOf` (app-config.ts:612) is `urls.os || request origin`. So wherever urls.os is set, every edge stamp is urls.os: worker.ts:397, mcp.ts:112/197 and rpc.ts:61.
- The DO seeds `#platformOrigin` from `appConfig.urls.os` at birth (:456-458), and the stateless resolver prefers it (stateless-context.ts:177).
- So on every iterate deployment, the learned kv row, `#withPlatformOrigin`'s write branch and the five refusals are unreachable. Only the no-domain self-host (SELF-HOSTING.md) leaves it blank. That self-host's recipe already derives the origin (setup-prompt.md:54), and its custom-domain path already requires urls.os (SELF-HOSTING.md step 5).

**The double memo is a strictly identical first step.** `itxEntrypointFor` already memoizes per ctx under the key [name, origin]. The DO's `#itxEntrypointStub` (:281-291) only re-mints through that function, so calling it directly returns the same stub object in every case, about −7 lines.

**The proposed shape is simpler.** It removes:

- a learned, persisted per-context state;
- a Caller field and its wire header;
- an entrypoint prop and a loader-id element;
- a redundant memo;
- five "call it from a session" error branches.

What remains is one required config value. That is a real cut in concepts, not a lateral move.

**The candidate misses these deltas; all are small, but the proposal must list them:**

1. **Guard relaxation.** `isPreviewOrLocalOrigin` (app-config.ts:530) accepts any https `*.workers.dev`. A self-host's blank urls.os is what currently refuses `login.testEmailDomain`, `admins` beside `login.password` or paths ingress, and `login.adminIssuer` there (the :529 comment says so). A self-host that names `https://iterate.<sub>.workers.dev` passes all three. The self-host operator writes APP_CONFIG and already holds the password and adminBearer, so this is a misconfiguration guard, not a security wall. The guard's stated purpose (:470-472) is prd on its own domain. Either accept the change, or narrow the check to iterate's preview subdomain `*.iterate-dev-preview.workers.dev` in one line (envs.ts:346). Pinned by the worker.test.ts rows that include `""`, e.g. :278 and :290.
2. **The http redirect goes dead.** The blank-origin http→https redirect (worker.ts:273-280) becomes unreachable and can be deleted for another −8 lines. After that, a self-host reached over plain http gets 421 "Unknown platform origin" (worker.ts:437) instead of a 308, which is what previews already do. A two-line redirect to urls.os would keep the old behaviour.
3. **Other hostnames get 421.** A self-host then answers only on urls.os. Its version-preview hostnames, or a custom domain added without updating urls.os, get 421 where they are served today as separate issuers.
4. **Deploy ordering.** The live self-host (iterate.templestein.workers.dev) must add the value before it redeploys from main. Otherwise `appConfigOf` throws on every request. This is loud, but it is a hard outage until fixed.
5. **Loader ids cost no extra restart.** Removing the origin element changes the ids, but ids already fold in `deployId`, which changes on every deploy. The change costs nothing beyond the deploy that ships it.
6. **Orphaned kv rows.** Old `platform-origin` kv rows remain in self-host DOs. They are harmless.
7. **One skew-window leak, harmless.** In a skew window, or from loaded code, an `x-itx-platform-origin` header is no longer stripped. Nothing reads it and it holds the public origin.

**What improves:** on a blank self-host, `itx.url`, `files.presign`, `beginOAuth`, `collectFromUser` and GitHub installation connects stop refusing from alarms and loaded code. `whoami.projectUrl` is always present.

**LOC, re-measured with sed/wc on the ranges**

- Context DO ranges (276-291, 453-458, 1662-1675, 1763-1766, 1069-1071): 43 lines. Adding the 3-line getter and removing about 6 scattered lines (import, :300, :1060, :1268, :1780) gives about −46.
- The built-ins refusals come to 23 lines, and deps and comments bring the file to about −28.
- The other product files match the candidate within a few lines: stateless-context about −10, worker-loader −7, rpc-stubs −8, caller −4, facet-host −2, github/verbs about −6, app-config about −6. worker.ts gives −10 if the redirect goes.
- Product total: about −120 to −125.
- Tests:
  - integrations.test.ts: the self-host row is 24 lines and the helper plus the SELF_HOST const 34, so about −58.
  - worker-loader.test.ts: :523-534 plus one id element, about −13.
  - worker.test.ts: the /version fallback half and the blank-origin rows go, and MINIMAL/MINIMAL_CONFIG gain urls.os, so about −12 net.
  - oauth.test.ts:126 gains one line.
  - rpc-stubs.test, pager-attach and facet-host.test give about −6.
- Tests total: about −80. The candidate's "about −200" holds.

**Scope.** The issuer side could also drop the `request` argument from `platformAddressesOf` at about 20 call sites, e.g. issuer-session.ts:43. That is optional and better left out of this PR.

**Risk:** low to medium, from the mechanical deletions plus the self-host config step. The loop limits, security walls and delivery guarantees are untouched.

## Delete the platform hook: a birth row that pushes every durable event of every project into an empty function

- Sweep index: 1; risk: low; payoff: 4/10
- LOC: About −65 in total.
- Product, −42: platform-hook.ts −14, built-ins.ts −16, envs.ts −10, itx-expression-rewriting.ts −2.
- Tests, −23: wake-causes.test.ts:77-97, fan-out-targets.test.ts:35, e2e/stream.e2e.test.ts:62. (skeptic measured: I applied the deletion to scratch copies and ran `git diff --no-index --numstat` against origin/main (b3daf4846).

| File                                              | Added | Removed |
| ------------------------------------------------- | ----- | ------- |
| apps/os/src/platform-hook.ts (`wc -l` = 14)       | 0     | 14      |
| apps/os/src/context/built-ins.ts                  | 3     | 20      |
| envs.ts                                           | 1     | 11      |
| apps/os/src/context/itx-expression-rewriting.ts   | 0     | 2       |
| apps/os/**workers-tests**/wake-causes.test.ts     | 0     | 21      |
| apps/os/**workers-tests**/fan-out-targets.test.ts | 0     | 1       |
| apps/os/e2e/stream.e2e.test.ts                    | 1     | 2       |

The built-ins.ts change is:

- the import, 1 line;
- the root type and its doc, 5 lines;
- the alias collapse, −3 and +2;
- the comment, −1 and +1;
- the implementation, 10 lines.

Product: +4 / −47, about −43 net. Tests: +1 / −24, about −23 net. Total about −66 net across 7 files. The comment at **workers-tests**/support.ts:38-39 also needs a one-line touch, roughly net 0.)

- Concepts: 4 concepts go to 0: the module, the implicit root on every project, the birth row, and the published-root exclusion.

### Evidence

Merged from 3 rows: the os-do-core parallel and heavy hunts, and the os-edge-api heavy hunt.

- apps/os/src/platform-hook.ts:11-14: `deliverToPlatformHook(_env, _event) {}`, with the comment "It does nothing with an event yet".
- envs.ts:56-66: the second PROJECT_CONTEXT_BIRTH_EVENTS row, `platform` → `itx.builtins.platformHook.deliverEvent` with `ordered: false`. #3446 keeps it.
- context/built-ins.ts:
  - :422-427: the root type.
  - :450-451: `PublishedRoot = Exclude<BuiltInRoot, "platformHook">`.
  - :2052-2061: the implementation, which runs assertDeliveryCaller (a SHA-256 of the event's JSON) before the no-op.
- itx-expression-rewriting.ts:86-87: the root's description. The root is implicit at every project `/`; packages/cli/proof/step1.out:188 shows it listed by rewriteRules.list().
- Per-event cost:
  - subscription-delivery.ts:1566-1597: a delivery record and the cursor written in one transaction, leased with an alarm claim.
  - :1679-1684: a DELETE on ack.
  - iterate-context-durable-object.ts:1192: a second SHA-256 in runAsDelivery.
- Added in #3425 (8c568dbf2, 09-29). The owner decided on 09-29 to "KEEP platform hook (made SDK-private)".

### Current shape

Every project context is born with a `platform` fan-out row. For every durable event, that row costs:

- a delivery-record write and delete
- a cursor write
- an alarm lease
- two SHA-256 hashes of the event's JSON
- a call to a built-in that does nothing

Keeping the root out of the published API needs its own type-level exclusion.

### Proposed shape

Delete platform-hook.ts, the `platform` birth row, and the `platformHook` root: its type, implementation, import and description. Also drop the carve-out:

```ts
export const PROJECT_CONTEXT_BIRTH_EVENTS = [
  {
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "config",
      target: "itx.builtins.cd('/').config.deliverEvent",
      afterOffset: 0,
      ordered: false,
    },
  },
] as const;
type PublishedRoot = BuiltInRoot;
```

The first platform feature that needs every event adds its own row and root in that feature's PR.

### What changes

Nothing observable is lost, because the hook runs no code.

Changes for new contexts:

- About 3 fewer SQL row writes and 2 fewer SHA-256s per durable event.
- No `platform` row in subscriptions.list().
- No itx.platformHook row in rewriteRules.list().
- The birth batch is one event shorter, so e2e/stream's first append lands one offset earlier (5 → 4 after #3446).

Contexts born since #3425 keep a row whose target no longer resolves. It dangles on its bounded probe ladder unless an operator appends `{ name: 'platform', target: null }` once, via the nightly sweep or the next erase.

This reverses the owner's 09-29 call to keep the seam.

### Pinned by

- **workers-tests**/wake-causes.test.ts:77
- **workers-tests**/fan-out-targets.test.ts:35
- e2e/stream.e2e.test.ts:55-66
- e2e/support/client.ts:331-333 derives its omit list from the constant.

### Skeptic's amended proposal

Delete the platform hook in one PR.

1. Remove apps/os/src/platform-hook.ts.
2. In built-ins.ts, remove the import (:64), the `platformHook` member of BuiltInScope (:418-422) and its implementation (:2047-2056).
3. Replace `type PublishedRoot = Exclude<BuiltInRoot, "platformHook">` with `BuiltInRoot` directly:
   `type RootsArePublished = [BuiltInRoot] extends [Exclude<keyof IterateContextApi, EdgeOnlyRoot>] ? [Exclude<keyof IterateContextApi, EdgeOnlyRoot>] extends [BuiltInRoot] ? true : never : never;`
   Trim the "but the platform's own hook" clause from the comment at :441.
4. Remove the `platformHook` description in itx-expression-rewriting.ts (:86-87).
5. In envs.ts, cut PROJECT_CONTEXT_BIRTH_EVENTS to the single `config` row, and make the doc comment speak of one row.
6. Tests:
   - Delete wake-causes.test.ts:77-97.
   - Drop the `platformHook` target at fan-out-targets.test.ts:35.
   - In stream.e2e, expect `offset: 4` and drop `"platform"` from the names list.
   - Touch the comment in **workers-tests**/support.ts:38-39.

In the PR body, say that this reverses Jonas's 09-25 "two built-in fan-out subscriptions" directive, and why:

- The seam costs about 4 storage row operations, an alarm reconcile and 2 SHA-256 hashes per durable event per context, for a no-op.
- The platform's DO already sees every commit of every context in `onCommit`, so a best-effort platform feature can start there.
- A feature that needs durable at-least-once delivery adds its row then, and backfills existing contexts, because birth rows reach only newborns.

Operational step: prd contexts born since #3425 deployed (09-29) keep a `platform` row that now dangles. It re-evaluates on every durable commit and probes on the bounded ladder. Retire those rows with one operator sweep appending `{ type: 'events.iterate.com/itx/subscription-configured', payload: { name: 'platform', target: null } }`, or leave them to the next erase. Add no compatibility code.

### Skeptic's verdict

The semantics claim holds. `deliverToPlatformHook` (apps/os/src/platform-hook.ts:11-14) is an empty body kept alive by an oxlint-disable of `no-single-use-helpers`, so no caller can observe what it does.

The cost is real and I checked it in the code:

- Every project context gets the row (iterate-context-durable-object.ts:543-547, where only GLOBAL is exempt).
- Every durable event on it is admitted in one transaction that writes a delivery record and the cursor (subscription-delivery.ts:1595-1600).
- On ack, the record is DELETEd and the cursor written again (:1679-1686), and the alarm is reconciled on each pump (:1402).
- The target head is evaluated.
- The event's JSON is hashed by assertDeliveryCaller (built-ins.ts:2049-2053) and hashed again in runAsDelivery.

That is about 4 storage row operations for every durable event of every context, and every one of them buys a no-op. The Workers-test helper even documents that it avoids birth rows because each call holds an alarm lease (**workers-tests**/support.ts:38-42).

The new shape is really simpler, not lateral. Four concepts go to zero: the module, the implicit `platformHook` root with its description row, the second birth row, and the `PublishedRoot` carve-out, which collapses to `BuiltInRoot`. No real guarantee is dropped: loop limits, delivery authority and the config row are untouched. `assertDeliveryCaller` stays in use by the webhooks and workers targets.

The candidate needs these corrections.

(1) Attribution. The reversal is of Jonas's own directive of 09-25: "every context gets TWO built-in fan-out subscriptions — userspace config worker processEvent … and a platform TRUSTED caller (reaches env)". The 09-29 KEEP was an agent's inference from those words. This is his call to make, and the candidate should say so plainly.

(2) A missed "almost". Birth events reach only contexts born after the change (envs.ts:42 and stream.ts appendBirthRecord). The row at birth is what pre-provisions every new context for a future platform subscriber. After the deletion:

- A later platform feature that needs durable at-least-once delivery for every event must add its row and backfill existing contexts.
- A best-effort feature can hook the DO's own `onCommit` (iterate-context-durable-object.ts:548), which already sees every commit of every context, old or new, with no row.
  This weakens the pre-provisioning argument, but the PR description must state it.

(3) Stale rows. The dangling behaviour is confirmed: `#walk` throws NO_ITX_EXPRESSION_MATCH for a missing root (itx-expression-rewriting.ts:1221-1225), which marks the row dangling (subscription-delivery.ts:1728-1733). The row then parks one record, admits nothing new, re-evaluates its target on every durable commit, and probes on the bounded ladder. Contexts born on prd since #3425 merged (2026-09-29 16:47 +0100, auto-deployed) need a one-time `{name:'platform', target:null}` append or the next erase.

(4) Evidence fixes:

- packages/cli/proof/step1.out does not exist on origin/main.
- #3446 is already merged (cfd8a1d36) and leaves the row in place.
- The per-event cost is about 4 row operations, not 3.

Tests that pin the current behaviour:

- **workers-tests**/wake-causes.test.ts:77-97 is deleted outright.
- **workers-tests**/fan-out-targets.test.ts:35 loses one row.
- e2e/stream.e2e.test.ts: the first user append moves from offset 5 to 4, and `"platform"` leaves the names list.
- processor-facets.e2e and push-delivery-no-dropped-warns.e2e adjust themselves through BIRTH_ROW_NAMES.size.
- worker.test.ts:422-432 maps the constant and needs no change.
- subscription-delivery.test.ts:1780 uses "platform" only as a label for a sink row, so it is unaffected.

Risk is low for code and moderate for owner intent.

## Drop the context's kv copy of its project slug: whoami already reads the same row through the 5 s control-plane cache

- Sweep index: 4; risk: low; payoff: 3/10
- LOC: About −29 in total.
- DO: −12 (15 lines become 3).
- Tests: project-lookups.test.ts:92-107 goes (−17). (skeptic measured: I drafted the amended change on scratch copies and ran git diff --no-index across 5 files: 13 insertions, 47 deletions, net −34.
- iterate-context-durable-object.ts: −21 (+6/−21 before netting gives 27 changed lines).
- project-lookups.test.ts: −17.
- built-ins.ts: +1 (+5/−4).
- stateless-context.ts: −1.
- catalog.ts: −2.
  The candidate's original shape, which keeps a separate primaryHostname line in each caller, comes to about −30.)
- Concepts: Two caches of one catalog row, read two ways, become one cache read the same way everywhere.

### Evidence

In apps/os/src/iterate-context-durable-object.ts:

- :1019-1033 `#projectSlug` stores `project-slug` in ctx.storage.kv. The stated reason (:1023) is that "a config worker asks `whoami` on every request". This came from #3123 on 09-24.
- :1038-1040 `primaryHostname` has read the same catalog row through control-plane/edge.ts `Kept` (5 s per isolate, :55-62 and :164-170) since #3283 on 09-27.

whoami (built-ins.ts:2141-2152) and itx.url (:2155-2170) call both. So the hot path the kv copy was added for now pays for the getProject read anyway.

The stateless resolver reads the row once, through the same cache (context/stateless-context.ts:188-194 and :233).

### Current shape

A context keeps two caches of one catalog row, and reads them differently from the stateless resolver:

- its slug, in its own kv, fetched once and kept forever;
- its primary hostname, from the isolate's 5 s cache.

### Proposed shape

```ts
#project = () => this.#durableObjectAddress.projectId === GLOBAL_PROJECT_ID
  ? Promise.resolve(null)
  : this.#controlPlane.getProject(this.#durableObjectAddress.projectId); // Kept 5 s
…projectConfigDeps(this.#appConfig, async () => (await this.#project())?.slug),
primaryHostname: async () => (await this.#project())?.primaryHostname ?? null,
```

The `project-slug` kv key and `#projectSlug` both go.

### What changes

- whoami and itx.url make the same reads as today.
- Paths that only need the slug (itx.r2.presign, collectFromUser) read through the 5 s isolate cache instead of kv. That is at most one D1 read per 5 s per isolate, and those paths now fail while D1 is down, as whoami already does.
- A context's first whoami no longer writes kv.
- The code no longer relies on 'a slug never changes'.

### Pinned by

**workers-tests**/project-lookups.test.ts:92 ("a project's context reads its slug from the control plane once and keeps it")

### Skeptic's amended proposal

This amends the candidate so that projectConfigDeps takes the reader's catalog row and derives both fields. That removes the duplicated primaryHostname dep in both callers.

In built-ins.ts:

```ts
/** What the built-ins read of the deployment and the project, a context's Durable Object's and
 *  the stateless resolver's alike: `project` is the reader's catalog row of its project (edge.ts
 *  `getProject`), null for a global context. */
export function projectConfigDeps(
  appConfig: AppConfig,
  project: () => Promise<{ slug: string; primaryHostname: string | null } | null>,
) {
  return {
    projectInfo: async () => {
      const slug = (await project())?.slug;
      return slug ? { projectSlug: slug } : {};
    },
    primaryHostname: async () => (await project())?.primaryHostname ?? null,
    ingressRouting: …, projectWildcard: …, fileUrlSecret: …,
  } satisfies Partial<BuildBuiltInsDeps>;
}
```

In iterate-context-durable-object.ts:

- #projectSlug goes, together with its 5-line doc and the `project-slug` kv get/put.
- The #controlPlane doc changes to: "its project's row, kept 5 s per isolate (edge.ts)".
- The builtIns deps become:

```ts
...projectConfigDeps(this.#appConfig, () =>
  this.#durableObjectAddress.projectId === GLOBAL_PROJECT_ID
    ? Promise.resolve(null)
    : this.#controlPlane.getProject(this.#durableObjectAddress.projectId),
),
```

The separate primaryHostname line goes.

In stateless-context.ts:

- The call becomes `projectConfigDeps(appConfig, project)`.
- The `primaryHostname:` line in the buildIdentityRoots call (:233) goes, because the spread projectDeps now carries it.

In catalog.ts:106-108, the comment is cut to "A row is only ever inserted or deleted, and the edge keeps a row `KEPT_MS` (edge.ts)."

In project-lookups.test.ts, the test at :92-107 is deleted.

Measured result: 5 files, +13/−47, net −34.

### Skeptic's verdict

I checked this against main at b3daf4846. PR #3446 only touches workersRoot in built-ins.ts, not this code. The candidate's line numbers are off by about 6: #controlPlane is at iterate-context-durable-object.ts:1026, #projectSlug at :1033-1042, and the builtIns deps at :1045-1049.

**The reason for the kv copy has expired twice over.**

1. The stated hot path is "a config worker asks whoami on every request". Loaded code's itx goes through ItxEntrypoint to statelessResolverFor (iterate-context.ts:611). whoami and url are IDENTITY_ROOTS (itx-expression-rewriting.ts:368 and :1187), so the stateless resolver answers them from getProject through the 5 s Kept cache. It never reaches the DO's kv copy at all.
2. The kv copy was added in #3123 on 09-24, when the control plane was a singleton. Since #3283 on 09-27, the DO's own whoami (built-ins.ts:2134-2152) also calls primaryHostname, which reads getProject, whenever a platform origin is set. prd and the previews always set one, through urls.os at DO:456. So on the paths it was built for, the kv copy saves zero D1 reads.

**(a) What changes:**

- **whoami and itx.url in the DO:** the same reads as today. The first call no longer writes kv. A self-host before its first stamped caller reads through Kept instead of kv, which makes no practical difference.
- **Slug-only paths in the DO:** these are itx.r2.presign (built-ins.ts:2299), email.send (:2320), secrets.collectFromUser (:1427) and integrations.requestFromUser (:1784). Each now makes at most one D1 read per 5 s per isolate, instead of one read in the context's life. After 5 s of a D1 outage they now fail UNAVAILABLE, as whoami already does. When loaded code calls these paths, the stateless resolver already behaves this way.
- **Deletion window:** between a project row's deletion and the context's destruction, slug-needing calls get the "only a project's context" error instead of a kept slug. That is arguably more correct.
- **Existing contexts:** they keep an inert `project-slug` kv key. It needs no migration.
- **Tests:** the only test that pins the current behaviour is project-lookups.test.ts:92-107, which overwrites the kv key and expects whoami to echo it. I checked the other whoami rows: control-plane.test.ts:47 and :213, root-census.test.ts:109, and project-host-control-plane-down.test.ts:104-143. None of them depends on the kv copy. The last one only fails accessibleTo.

**(b) Simpler, not just different:**

- One cache of one row, read the same way by the DO and the stateless resolver, instead of a durable per-context copy plus the isolate cache.
- It also deletes a cross-module invariant. catalog.ts:106-108 currently documents that a context's `project-slug` relies on rows never being updated.
- The amendment below goes further than the candidate: projectConfigDeps takes the row getter and derives both the slug and primaryHostname. Both callers pass the same thing, and the primaryHostname line duplicated between the DO and the stateless resolver goes.

**(c) Guarantees:** it drops none. The kv copy is a pure cache, and the edge's catalog cache stays the single source.

**Payoff:** a modest but real "expired workaround / two mechanisms for one job" cleanup. It is small in volume and not central, so the payoff is 3.
