# Sweep candidates: cross

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## Platform reads of an owner context's facet state go through one helper at the fixed point; half of them bypass it today, and so do the revocation reads

- Sweep index: 91; risk: low; payoff: 4/10
- LOC: About −25 net, from the per-area measurements:
- oauth.ts/identity.ts/session.ts: −9 to −12. The move is net 0; the two inline copies are −13.
- built-ins.ts: −9 (−25/+16, measured on an oxfmt simulation).
- helper: +6.
- collection.ts and connections.ts: about −3.
- Tests: 3 expectations change in session.test.ts, and 1 fake in oauth.test.ts. (skeptic measured: I simulated both shapes on copies of the origin/main files (b3daf4846, which already includes #3446), formatted them with the repo's oxfmt config and ran `git diff --no-index --numstat`.
- Helper shape (amended): +64/−69 across 6 files, so −5 net. By file: built-ins.ts +22/−36, context-stub.ts +16/−0 (the helper and its docstring), identity.ts +9/−8, connections.ts +6/−7, oauth.ts +7/−9, session.ts +4/−9.
- Spelling-only fix with no helper: +24/−8 across 4 files, so +16 net, because oxfmt wraps the longer arrays.
- The candidate's "about −25" is wrong by about 5x. Its accountStateOf move is net 0 and adds import churn in oauth.ts, grants.ts, issuer-session.ts and oauth.test.ts. collection.ts does not fit the helper.
- Test edits come on top: session.test.ts 3 expectations, the oauth.test.ts fake, first-account-read.test.ts:29 and sign-in-code-exchange-fails.test.ts:164.)
- Concepts: Before: 2 spellings of a platform hop, 12 hand-written reads across 7 files, and 3 read routes (maskable hop, fixed hop, local call).

After: 1 spelling, 1 helper, and 2 read routes (fixed hop, local call).

### Evidence

Merged from the os-edge-api parallel and heavy hunts and the os-context-builtins parallel hunt, then re-checked at HEAD ce251e06c.

12 platform reads of `['itx', …'facets', ['get', F], …]` across 7 files are split two ways.

At the fixed point, via `itx.builtins`:

- session.ts:289
- identity.ts:629
- connections.ts:246
- built-ins.ts:791
- built-ins.ts:1516

Through the owner's own rewrite table:

- oauth.ts:125 `accountStateOf`. This is the revocation truth for every admission (oauth.ts:170), PAT admission (:480) and refresh (:540).
- built-ins.ts:832, :923, :1375 and :1639: connectCallersAccount, disconnectedFromProject, secrets.list, borrowEveryProjectLends.
- session.ts:245 appendPlatformFacts' `waitUntilProcessed`, with `processors.enable` at :237.
- project/collection.ts:53.

Why the second group matters:

- caller.ts:38-44 states the rule: 'the fixed point is what no rewrite rule redirects'.
- A person can append rows to their own /users/<id>: control-plane-contexts.test.ts:35 ('session.user has the full itx surface'), and itx-expression-rewriting.ts:12-15.
- refuseNonPlatformWrites (caller.ts:157-176) blocks only platform fact types and `itx.config` rows.
- #3446 made the same fixed-point move for the config row (`itx.builtins.cd('/')`).
- Each built-ins site also repeats the same `// invoke is untyped…` cast and destructure.

### Current shape

About six platform call sites in the edge, built-ins and collection each hand-spell a hop to an owner facet's snapshot, and half of them resolve through that context's own rules. On /users/<id> this includes the grant-revocation read: a row the person writes at `itx.facets` could mask it, making every admission fail, or answer it with an empty `endedGrants`.

### Proposed shape

```ts
// src/context-stub.ts
/** A facet's state on `context`, read at the fixed point: no row of that context's redirects it. */
export async function facetStateOf<S>(
  context: { invoke(e: ItxExpression, a: unknown[], c: Caller): Promise<unknown> },
  facet: string,
  caller: Caller,
): Promise<S> {
  return (
    (await context.invoke(
      ["itx", "builtins", "facets", ["get", facet], ["snapshot"]],
      [],
      caller,
    )) as { state: S }
  ).state;
}
// session.ts
export const accountStateOf = (ns: IterateContextNamespace, userId: string) =>
  watchSlowStep(
    { event: "oauth.step-slow", step: "account-state", userId },
    facetStateOf<AccountState>(ownerContext(ns, { account: userId }, "oauth"), "account", {
      principal: null,
    }),
  );
```

- oauth.ts, grants.ts, issuer-session.ts, identity.ts `personConnectionOf` and session.ts `endLendsOutOfReach` call accountStateOf. It moves beside ownerContext to avoid a session↔oauth import cycle.
- The built-ins sites call `facetStateOf(deps.context(owner.rootPath), F, hopCaller())`.
- appendPlatformFacts spells `['itx','builtins','processors',…]` and `['itx','builtins','facets',…,['waitUntilProcessed',…]]`.

### What changes

Behaviour change: the platform's own reads and writes of an owner context stop resolving through that context's rewrite rules. So a person's own row at `itx.facets` on /users/<id> can no longer:

- redirect or mask the revocation read, or keep an ended grant admitted through a lent stub;
- make every platform fact on the account fail.

This follows from the resolver's rules as read, and is not yet proven by a test. Write a red Workers row first.

Smaller changes:

- identity.ts and session.ts reads gain the slow-step watchdog and log under area `oauth`.
- identity.ts's read runs with principal null.
- With the implicit platform row in place, every answer is identical today.

### Pinned by

- src/session.test.ts:29, 41, 65 (the exact expressions)
- src/oauth.test.ts:136, whose fake keys on `surface === 'facets'` at index 1
- **workers-tests**/first-account-read.test.ts:29, which pins the maskable expression
- identity.test.ts (connection reuse)
- connect-your-account, integrations and instance-lends tests
- e2e/secrets.e2e and secrets-connections.e2e

### Skeptic's amended proposal

One PR. Start with a red Workers row in **workers-tests**. A person appends `{type:"events.iterate.com/itx/rewrite-rule-configured", payload:{match:"itx.facets", target:null}}` to `session.user`. Their next token admission (`grantIsLive`) and their logout (the grant's end through appendPlatformFacts) must both still work. Both fail today.

Then add a helper beside contextStub in src/context-stub.ts:

```ts
/** A first-party facet's state on `context`, read at the fixed point: no row of that context's
 *  redirects or masks the platform's own read. */
export async function facetStateOf<State>(
  context: { invoke(call: ItxExpression, args: unknown[], caller: Caller): Promise<unknown> },
  facet: string,
  caller: Caller,
): Promise<State> {
  const snapshot = await context.invoke(
    ["itx", "builtins", "facets", ["get", facet], ["snapshot"]],
    [],
    caller,
  );
  return (snapshot as { state: State }).state;
}
```

- oauth.ts:119: accountStateOf stays in oauth.ts with the same signature. It becomes `watchSlowStep({...}, facetStateOf<AccountState>(ownerContext(env.ITERATE_CONTEXT, { account: userId }, "oauth"), "account", { principal: null }))`.
- built-ins.ts:790, 830, 922, 1373, 1515 and 1637 become `facetStateOf<T>(ctx, F, caller)`, each keeping its existing caller.
- identity.ts:628, session.ts:283 and connections.ts:244 become `facetStateOf`, each keeping its own caller and area.
- Non-snapshot calls are spelled at the fixed point in place: session.ts:237 `["itx","builtins","processors",["enable",p]]`, session.ts:245 `["itx","builtins","facets",["get",p],["waitUntilProcessed",{offset}]]`, and identity.ts:653 `["itx","builtins","processors",["enable","account"]]`.
- Leave collection.ts alone. So are session.ts:1094 and :1173, the project root's own enable through its own rows.

Update these tests:

- session.test.ts:29, 41 and 65: expressions gain `"builtins"`.
- oauth.test.ts:133-136: the fake keys on index 2 (`"facets"`) under `"builtins"`.
- first-account-read.test.ts:29: the expression.
- sign-in-code-exchange-fails.test.ts:164: log name `itx.builtins.facets.get.snapshot`.

The measured result is −5 source LOC across 6 files, with 1 helper added, 1 spelling and the maskable route removed, and 8 duplicate cast comments removed.

### Skeptic's verdict

(a) The semantics claim holds when checked against the resolver. `resolveItxExpression` (itx-expression-rewriting.ts) returns at once for a call rooted at `itx.builtins` and never reads the rules table. A row at `itx.facets` with a target does not yield to the implicit row. `normalizeRewriteRuleConfigured` accepts `{match:"itx.facets", target:null}`; core-processor.test.ts:1023 builds exactly that mask. control-plane-contexts.test.ts:35 shows a person has the full itx surface on /users/<id>. refuseNonPlatformWrites (caller.ts) refuses only platform fact types and `itx.config` rows.

So today a person's own row on their account can mask or redirect:

- oauth.ts:125, the revocation truth read by every admission, PAT admission and refresh;
- session.ts:237 and :245, the processor enable and the barrier that every awaited platform fact, including a grant's end, goes through;
- identity.ts:653, which the candidate missed.

This breaks the module's own doctrine at itx-expression-rewriting.ts:12-15 ("THE PLATFORM'S OWN SPELLINGS ARE ROOTED AT `itx.builtins` … so a user's row at `itx.facets` … redirects the user's calls and nothing else"). **workers-tests**/project-seed.test.ts:54 pins the same principle for callFacetAsPlatform.

Behaviour that does NOT change:

- Retries: `isIdempotentItxCall` (context-stub.ts:185) strips `builtins`, so the "read sent once more after a deploy reset" guarantee is identical.
- Facet read-at-head is identical, because both spellings end at `itx.builtins.facets`.
- Absent user rows, every answer is identical.

Behaviour that DOES change:

1. User rows no longer affect these platform calls. That is the intended fix, and no test or caller relies on the masking.
2. The retry log's `name` becomes `itx.builtins.facets.get.snapshot` (context-stub.ts:76). sign-in-code-exchange-fails.test.ts:164 pins it.
3. A fixed-point call does not materialize the rules table, which is marginally cheaper.

(b) It is simpler in concepts, not in lines:

- 2 spellings of the platform's own facet call become 1.
- The "maskable hop" read route disappears.
- 10 hand-rolled `invoke`-cast-destructure blocks and 8 copies of the "`invoke` is untyped across the DO hop" comment become one 16-line helper.
- The line win is only −5. This is a drifted-copy correctness fix (drifted copy-paste is on the listed examples) more than heavy junk.

Mis-specifications in the candidate:

- Moving accountStateOf to session.ts is churn. The helper covers identity.ts, and session.ts endLendsOutOfReach already spells the fixed point.
- It would also silently switch identity's principal and put an `oauth` watchdog on the identity read.
- collection.ts:53 calls through a first-party facet's SDK proxy (`invoke(steps)`, no caller), which does not fit the helper's signature. It reads repo contexts whose rows are the project's own, so nothing is gained there.

(c) No guarantee is dropped. The change restores one: platform reads and writes on an owner context can no longer be masked or redirected by that owner's rows. That exploit (an ended grant kept admitted, or every admission failing) follows from the code but is not yet demonstrated. Write the red Workers row first.

(d) Measured LOC is −5 with the helper and +16 with spelling only, not −25.

## One content hash in apps/os (sha256Hex), not three SHA-256 helpers and two hand-rolled FNV/djb2 hashes

- Sweep index: 92; risk: low; payoff: 3/10
- LOC: About −24 in total:
- secrets.ts: −5
- module-resolution.ts: −5
- imports: +2
- worker-loader.ts: 24 lines become 8 (−16)

The route-digest row removes the third FNV separately (−11 of its −61). (skeptic measured: I applied the change to scratch copies of the seven files (hashsim/a and hashsim/b in the scratchpad) and measured with `git diff --no-index --numstat`: +13 / −51, net −38.

- worker-loader.ts: −15 (+5/−20)
- worker-loader.test.ts: −12. This deletes the "djb2 hashes collide" test and changes the regex at :494 to /^content:[0-9a-f]{64}$/.
- secrets.ts: −6
- module-resolution.ts: −4
- built-ins.ts: −1
- email.ts: −1
- exchange-jail.ts: +1

Source files alone come to −26, so the candidate's "about −24" is close. The route-digest FNV is not counted here.)

- Concepts: Before: 5 hash implementations in apps/os/src (sha256Hex ×2, a private sha256, djb2+FNV, and routeDigestOf's FNV).

After: 1, sha256Hex.

### Evidence

Merges the routing hunt's SHA-256 row with its heavy double-hash row. Checked across the repo at HEAD.

SHA-256 hex, three byte-identical copies:

- apps/os/src/caller.ts:245-252 `sha256Hex`, imported by worker-loader.ts:33 and five other modules.
- secrets.ts:472-476, a second `sha256Hex`, imported by built-ins.ts:60, integrations/email.ts:45 and secret/exchange-jail.ts:22.
- context/module-resolution.ts:351-353, a private `sha256` used once, for the module-lock key.

Non-cryptographic hashes:

- worker-loader.ts:158-181 `contentHashOfWorkerModules`: djb2 + FNV-1a 32-bit + length. Its comment says it is 'SYNCHRONOUS on purpose (the commit path, where crypto.subtle cannot run)'. Both callers are now async: worker-loader.ts:269 inside `prepareConfinedWorker`, and built-ins.ts:1982 inside `processors.enable`.
- subscription-delivery.ts:1952-1962 `routeDigestOf`, a third FNV-1a. The route-digest row deletes it.
- `rg 0x811c9dc5` also finds petshop state.ts:195, a deterministic fake id, which is out of scope.

Aside, found while reading: the dead-id recovery's single-flight (worker-loader.ts:128-131, 355-389) is keyed by the itxEntrypoint stub. That stub is memoized per ExecutionContext, and every project-host request has its own ctx (worker.ts:170). So a burst of stateless requests on a dead loader id runs one producer per request, the shape of the 09-24 incident. This is a hazard, not part of this change, and was not reproduced.

### Current shape

Within one app, the same digest is written three times, and loader identities use a bespoke dual 32-bit hash justified by a synchronous path that no longer calls it.

### Proposed shape

```ts
// module-resolution.ts / built-ins / email / exchange-jail: import { sha256Hex } from '../caller.ts'
const key = `module-lock-2/${await sha256Hex(JSON.stringify(lockInput))}`;
// worker-loader.ts
const contentHashByWorkerModules = new WeakMap<WorkerModules, Promise<string>>();
export function contentHashOfWorkerModules(modules: WorkerModules): Promise<string> {
  let hash = contentHashByWorkerModules.get(modules);
  if (!hash) contentHashByWorkerModules.set(modules, (hash = sha256Hex(JSON.stringify(modules))));
  return hash;
}
// the two call sites add `await`
```

### What changes

- The SHA-256 dedupe changes nothing: `module-lock-2/`, `produced-modules-1/` and `secret-exchange:` keys are unchanged.
- A literal source's loader identity changes from `content:<djb2>-<fnv>-<len>` to `content:<sha256>`. Every facet or worker hosted from a literal source loads once under a new identity and restarts in place with its storage kept, as every deploy already does.
- A processor re-enabled with an unchanged literal source appends one `subscription-configured`.
- Collision resistance goes from 64 bits plus length to 256 bits.

### Pinned by

- src/context/worker-loader.test.ts:221 (different content gives different ids) and :43-50
- context/module-resolution.test.ts
- the exchange-jail and email tests
- caller.ts token-hash tests

### Skeptic's amended proposal

Put one SHA-256 helper in apps/os: caller.ts `sha256Hex`.

1. secrets.ts: delete `sha256Hex` (:472-476). built-ins.ts, integrations/email.ts and secret/exchange-jail.ts import it from `../caller.ts`.
2. context/module-resolution.ts: delete the private `sha256` (:351-354), then `import { sha256Hex } from "../caller.ts"` and write `module-lock-2/${await sha256Hex(JSON.stringify(lockInput))}`.
3. worker-loader.ts: replace the djb2/FNV body and its "synchronous on purpose" comment with:

```ts
/** The content hash of a literal module map, memoized by the map's IDENTITY: the DO hands the SAME
 *  startup-memo object per facet per incarnation, so it is hashed once per source per incarnation. */
const contentHashByWorkerModules = new WeakMap<WorkerModules, Promise<string>>();
export function contentHashOfWorkerModules(modules: WorkerModules): Promise<string> {
  let hash = contentHashByWorkerModules.get(modules);
  if (!hash) contentHashByWorkerModules.set(modules, (hash = sha256Hex(JSON.stringify(modules))));
  return hash;
}
```

Then add `await` at worker-loader.ts:277 (`content:${await contentHashOfWorkerModules(modules)}`) and at built-ins.ts:1977 (`cacheKey: await contentHashOfWorkerModules(given.source)`). 4. worker-loader.test.ts: delete the "djb2 hashes collide" test at :18-29 and change :494 to `/^content:[0-9a-f]{64}$/`.

What changes (the "almost"):

- Literal-source loader ids are spelled differently. That restart is absorbed by the deploy that ships the change, since `deployId` is already in the id.
- A processor enabled earlier with a literal source and no cacheKey appends one `subscription-configured` on its next enable and restarts once more, with storage kept.

Measured LOC: net −38, of which −26 is source and −12 is test.

### Skeptic's verdict

The claims hold against origin/main at b3daf4846. PR #3446 is already merged there and does not touch any of these helpers.

(a) Semantics

- caller.ts:245-252 `sha256Hex` and secrets.ts:472-476 `sha256Hex` produce byte-identical output. So does module-resolution.ts:351-354 `sha256`, which is used once at :375 for the module-lock key. All three are UTF-8 through TextEncoder, then SHA-256, then lowercase hex. The keys `module-lock-2/`, `secret-exchange:`, `produced-modules-1/` and `refreshSourceSha256` do not change.
- secrets.ts already imports caller.ts, so no import cycle is added. The move touches these imports: built-ins.ts:55-61 (the secrets.ts block) and :42, email.ts:42/46, exchange-jail.ts:23, and a new import in module-resolution.ts.
- The "SYNCHRONOUS on purpose (the commit path, where crypto.subtle cannot run)" reason at worker-loader.ts:166-171 has expired. More precisely, it was already stale when the clean-room code was written: at 8d402da26 its only caller was the async `loadConfinedWorker`. Today its only callers are worker-loader.ts:277 inside the async `prepareConfinedWorker` and built-ins.ts:1977 inside `processors.enable: async`.
- In both call sites the new await comes before the state read that follows: `loaderIdGenerations.get`, and `subscriptions.get` plus the append. So no read-then-write gap opens, and the WebCrypto digest is not I/O, so it does not open the input gate.

Behaviours that change:

1. A literal source's loader id changes from `content:<djb2>-<fnv>-<len>` to `content:<64 hex>`. The loader id already folds in `deployId`, so the deploy that ships this already restarts every such facet once. The code comment at :350-354 says exactly this: "the same as a deploy does". This adds no restart of its own.
2. A processor enabled with a literal source and no cacheKey stores the old-format hash as `cacheKey` in its hostedFacet marker. Its next `processors.enable` compares unequal, so it appends one `subscription-configured` and restarts that facet once more, with storage kept. This is one step beyond what the candidate stated. The real first-party callers (agents, github-sync) use expression sources with no hash, so in practice this only reaches tests and user code.
3. The in-memory memo now holds a Promise instead of a string.
4. A theoretical case: two sources that differ only in lone UTF-16 surrogates would collide after TextEncoder replaces them. This is negligible.

Tests that pin the current behaviour: worker-loader.test.ts:18 (the djb2 collision test, which becomes vacuous and should be deleted, since :221 "content decides" covers the same point) and :494 (the format regex, one-line update). No Workers or e2e test pins the `content:` spelling.

(b) It is simpler, not lateral. The code drops from five hash routines to three: sha256Hex, routeDigestOf and git-wire's SHA-1. It drops to two once the route-digest row lands, not one as the candidate says. It deletes a 6-line comment defending a bespoke dual 32-bit hash and the test that pins that hash's collision behaviour. The memo WeakMap stays, because prepare runs on every push and the host hands over the same startup-memo object.

(c) No guarantee is dropped. Collision resistance goes up, from about 64 bits plus length to 256 bits.

The payoff is modest: a stale workaround plus copy-pasted helpers, around −38 lines in the loader, which is central code. It is more than a nit, but not heavy junk.

Corrections to the candidate's evidence: the helper is at worker-loader.ts:166-188 (not 158-181) and the call sites are :277 and built-ins.ts:1977 (not 269 and 1982). The single-flight aside about `itxEntrypoint` was not verified and is out of scope. Test-side SHA copies (secrets-connections.e2e.test.ts:601, secret-exchange-code.test.ts:194) should stay as independent oracles.

## Cloudflare API listings return whole listings: one pager in cloudflareApi replaces five hand-rolled pagers, erase-data's second client, and do-duration-probe's raw fetches

- Sweep index: 94; risk: medium; payoff: 5/10
- LOC: About −55 to −65 across 7 files, measured with sed and wc:
- erase-data: 43 → about 5
- preview.ts: −17
- d1.ts: −7
- do-reset.ts: −12
- env-context guard → pager: +10
- erase-data.test fetch stub: −16
- env-context.test: about +25

On top of that, about −4 in context-sweep.ts and about −15 in do-duration-probe.ts. (skeptic measured: I applied the edits to copies under scratchpad/pager and formatted them with oxfmt:

- scripts/lib/env-context.ts: 212 → 222 (+10)
- apps/os/scripts/erase-data.ts: 376 → 337 (−39)
- apps/os/scripts/preview.ts: 1374 → 1362 (−12; the R2 guard is kept)
- apps/os/scripts/d1.ts: 125 → 121 (−4)
- scripts/lib/do-reset.ts: 135 → 128 (−7)
- scripts/ci/context-sweep.ts: 493 → 487 (−6)
- scripts/monitors/do-duration-probe.ts: 366 → 348 (−18)
- Production total: −76
- apps/os/scripts/erase-data.test.ts: 260 → 248 (−12)
- scripts/lib/env-context.test.ts: about +45 for the new pager table (estimated, not written)
- Net: about −43)
- Concepts: Before, 7 ways to list:
- the truncation guard
- erase-data's own client
- listAll
- the findD1 loop
- the do-reset loop
- one-page-and-refuse ×2
- raw unretried fetches

After, 1: a GET listing is the whole listing.

### Evidence

Merges the os-scripts-env parallel and heavy hunts, extended repo-wide at HEAD.

The shared client cannot page:

- scripts/lib/env-context.ts:96-143 `cloudflareApi` is 'THE choke point for every Cloudflare API call'.
- It returns only `body.result`, so a caller never sees `result_info`.
- It throws on a truncated page-numbered listing (:124-138), with the message 'raise per_page or paginate'.

So each caller copes on its own:

- apps/os/scripts/erase-data.ts:29-34 and :122-158 is a second Cloudflare client: its own retrying fetch, bearer, envelope schema, cursor loop and repeated-cursor guard. Its comment: 'cf() intentionally … drops pagination cursors'.
- Page loops: preview.ts:156-167 `listAll`, d1.ts:22-30 `findD1`, do-reset.ts:33-54.
- One page, then refuse: preview.ts:199-212 (R2), and scripts/ci/context-sweep.ts:140-142 and :167-170. The prd context sweep will stop working at 10k contexts.
- ensure-resources.ts:36 reads one page with no guard.
- scripts/monitors/do-duration-probe.ts:184-220 reads the same DO-namespace listing twice with a raw `fetch`: one 1000-row page, no retry, no timeout, a cast envelope. Its GraphQL helper (:39-60) is also raw.

On the test side, erase-data.test.ts:232-247 stubs global fetch only because the listings bypass `cf`.

For contrast, preview.ts:560 lets Octokit's `paginate` do this for GitHub.

### Current shape

The shared Cloudflare client can never return a whole listing. Scripts and monitors therefore carry:

- three page loops
- a private cursor client
- two refuse-if-full guards
- an unguarded single page
- raw fetches that skip the shared retry and timeout entirely

### Proposed shape

```ts
// cloudflareApi: a GET whose result is an array and whose path names no page or cursor follows the listing to its end
if (
  method !== "GET" ||
  !Array.isArray(body?.result) ||
  url.searchParams.has("page") ||
  url.searchParams.has("cursor")
)
  return body?.result;
const rows = [...body.result];
const seen = new Set<string>();
for (let info = body.result_info, page = 1; ;) {
  const next = info?.cursor
    ? { cursor: info.cursor }
    : (info?.total_count ?? 0) > rows.length || fullPage(url, body.result)
      ? { page: String(++page) }
      : undefined;
  if (!next) return rows;
  if (next.cursor && seen.has(next.cursor))
    throw new Error(`Cloudflare API ${path} repeated its cursor`);
  if (next.cursor) seen.add(next.cursor);
  const more = await one(withParams(path, next));
  rows.push(...more.result);
  info = more.result_info;
}
```

The callers:

- erase-data `listNames` becomes `z.array(...).parse(await cf(store.route))`.
- `listAll` and the R2 guard go.
- `findD1`, do-reset and context-sweep make one call each.
- do-duration-probe uses `cloudflareApi(apiToken)` for the namespace listing and the credential proof.

### What changes

- A GET listing with no explicit page or cursor returns every page, where today it returns page 1 or throws.
- More than 1000 R2 buckets, or 10k+ DO objects in the sweep, stop being refusals.
- erase-data's listings go through the shared client with the same schedule, idempotency and 60 s timeout.
- do-duration-probe's namespace reads gain retries and the timeout. A failed listing throws instead of silently falling back to bare ids. Keep the `.catch` if the fallback matters.
- Calls that name `page=1` still read one page (deleteArtifactsRound).
- deleteR2Bucket's `?per_page=1000` read now reads every object per round: fewer rounds, same end state.
- Check once against the live API: /artifacts/namespaces may omit total_count. So the pager also follows a full `per_page` page, as listAll does today.

### Pinned by

- apps/os/scripts/erase-data.test.ts:29 ('…including later KV pages'), stubbing global fetch at :232-247
- d1.test.ts:23 (route `/d1/database?per_page=100&page=1`)
- do-reset.test.ts:70-76
- scripts/ci/context-sweep.test.ts:424-425 (the namespace URL with page=1)
- do-duration-probe has no unit rows for these reads

### Skeptic's amended proposal

**`cloudflareApi` reads a GET listing whole.** Split the current body into `request(path, init)`, which returns the envelope with the retry, timeout and CloudflareApiError all unchanged. Then:

```ts
return async <T>(path: string, init?: RequestInit): Promise<T> => {
  let body = await request(path, init);
  // A listing is read whole: its cursor followed, else its pages while more are counted or a page comes back full.
  // A path that names its page or cursor reads that one.
  const url = new URL(path, "https://api.cloudflare.com");
  if (
    (init?.method ?? "GET") !== "GET" ||
    !Array.isArray(body?.result) ||
    /[?&](page|cursor)=/.test(path)
  )
    return body?.result as T;
  const rows = [...body.result];
  const cursors = new Set<string>();
  for (let page = 2; body.result.length; page++) {
    const { cursor, total_count: total, per_page: size } = body.result_info ?? {};
    if (cursor && cursors.has(cursor))
      throw new Error(`Cloudflare API ${path} repeated its cursor`);
    if (cursor) (cursors.add(cursor), url.searchParams.set("cursor", cursor));
    else if (
      total > rows.length ||
      body.result.length === Number(size ?? url.searchParams.get("per_page"))
    )
      url.searchParams.set("page", String(page));
    else break;
    body = await request(`${url.pathname}${url.search}`, init);
    rows.push(...body.result);
  }
  return rows as T;
};
```

This replaces the truncation guard at :124-138.

**Callers:**

- **erase-data:** `listNames = (store) => z.array(z.object({ [store.field]: z.string().min(1) })).parse(await cf(store.route)).map((item) => item[store.field]!)`. The `Listing` schema, the private fetch loop and the platform-retry import all go.
- **preview.ts:** `listAll` is deleted. Each of its 8 call sites becomes `cf<Row[]>("<route>?per_page=100")`, keeping `per_page` so the full-page rule matches today's paging exactly. The R2 bucket guard (:199-212) STAYS because the `{buckets}` result is not an array. Only its comment changes.
- **d1.ts:** `findD1 = (await cf<D1Row[]>("/d1/database?per_page=100")).find((row) => row.name === name)`.
- **do-reset.ts:** `getWorkerDoNamespaces` makes one call and a filter/map.
- **context-sweep.ts:** `OBJECTS_PAGE` and the refuse-if-full check go. It reads `…/objects?limit=10000` once.
- **do-duration-probe.ts:**
  - The name listing becomes `cloudflareApi(apiToken)<{id,name}[]>(…?per_page=1000).catch(() => [])`, so the fallback to bare ids is kept.
  - `proveCredentials` calls `…?per_page=1&page=1`. The `page=1` is REQUIRED, or it pages the whole account. It re-wraps the error in its "misconfiguration, not quiet" message.
  - `cfGraphql` stays raw, because its envelope differs.
- **preview-artifacts.ts:254:** the comment becomes "a named page reads one page".
- **Out of scope:** ensure-resources.ts:36, which is also a `{buckets}` result.

**Tests:**

- erase-data.test's fake `cf` answers listing GETs from `fixture.stores`, and the fetch stub is deleted.
- env-context.test gains a `cloudflareApi listing` table with five cases:
  - cursor pages
  - counted pages
  - uncounted full pages
  - a named page read once
  - a repeated cursor refused
- d1.test.ts:26 and context-sweep.test.ts:425 drop `&page=1` from their expected routes.

**Semantics that change:**

- Listings refused today (10k+ DO objects, a counted overflow) and cursor listings cut short today are read whole.
- `findD1` reads every D1 page.
- `deleteR2Bucket` reads all objects each round.
- The probe's namespace read gains retry and a timeout before it falls back.
- erase-data's listing errors become CloudflareApiError.

### Skeptic's verdict

The core claim holds, but the candidate gets some details wrong and overstates the LOC saving.

**What is true.** `cloudflareApi` (scripts/lib/env-context.ts:96-143) returns only `body.result`. Its guard (:124-138) refuses a page-numbered listing cut short by `total_count`. It silently cuts short every cursor listing (KV keys, R2 objects, DO objects), because those carry no `total_count`. So the one choke point gives an uneven guarantee, and each caller copes on its own:

- erase-data.ts:12, :29-34 and :122-158 is a whole second Cloudflare client: the same retry schedule, 60 s timeout and bearer, its own envelope schema and cursor loop.
- Hand-rolled page loops: `listAll` (preview.ts:156-167, 8 call sites), `findD1` (d1.ts:24-30) and `getWorkerDoNamespaces` (do-reset.ts:37-53).
- context-sweep.ts:140-142 and :166-170 read one page of 10k and refuse a full one.
- do-duration-probe.ts:184-196 and :203-221 use raw `fetch` with no retry and no timeout.

Turning "raise per_page or paginate" into actually paginating removes all of that. It gives one rule that is easy to explain: a GET listing is the whole listing unless the path names its page or cursor. PR #3446 touches preview.ts and do-reset.ts only in unrelated lines (a comment, and wrangler's `--tag`/`--message`).

**Where the candidate is wrong:**

1. **R2 bucket listings stay.** `/r2/buckets` answers `{buckets:[…]}`, an object and not an array, so the proposed `Array.isArray` pager never touches it. The R2 guard at preview.ts:199-212 stays (only its comment changes), and ensure-resources.ts:36 stays unguarded. The claim "listAll and the R2 guard go" is half false.
2. **`proveCredentials` must name `page=1`.** It reads `?per_page=1` only to prove the credentials work. Under an auto-pager it would read about 400 pages of dev/preview's namespaces, one request each.
3. **`fullPage` is undefined in the sketch.** It must be `result_info.per_page ?? the URL's per_page`, and an empty page must end the loop. Callers of `listAll` keep `?per_page=100` in their path. Then an endpoint whose paging is unknown (Artifacts namespaces, Worker Previews) pages exactly as `listAll` does today. An endpoint that ignores `page` could loop forever, but that risk already exists with `listAll`.
4. **The GraphQL helper stays raw.** Its `{data, errors}` envelope is not `cloudflareApi`'s shape.

**Semantics that change, all at the edges:**

- Listings that are refused today become whole: DO objects past 10k in the sweep, and zones or KV namespaces past `total_count`.
- Cursor listings read through `cf` become whole instead of silently cut short. For example, `deleteR2Bucket` reads every object each round: fewer rounds, same end state.
- `findD1` no longer stops at the first page that matches (a few extra GETs on dev).
- erase-data's "before" count for Artifacts repos becomes the true total, if that listing is page-numbered. A listing failure becomes a `CloudflareApiError` instead of a ZodError.
- The probe's namespace read gains a 60 s timeout and up to about 4 minutes of retries on 429 or 5xx before its `.catch` falls back to bare ids. `proveCredentials` keeps its message by re-wrapping the error.
- `page=1` callers are unchanged (deleteArtifactsRound).

**Guarantees:** none dropped. The truncation guarantee gets stronger, because it now covers cursor listings too, and the repeated-cursor refusal moves into the pager.

**Tests that change:**

- erase-data.test.ts:232-247: the fetch stub goes, and the fake `cf` answers the listing routes. The "later KV pages" case moves to a new env-context.test table.
- d1.test.ts:26 and context-sweep.test.ts:425: the expected routes lose `&page=1`.
- do-reset.test.ts:70-76: its fake still works.

**LOC:** I applied the edits to copies in the scratchpad and ran oxfmt:

- env-context.ts: +10 (212 → 222)
- erase-data.ts: −39
- preview.ts: −12
- d1.ts: −4
- do-reset.ts: −7
- context-sweep.ts: −6
- do-duration-probe.ts: −18
- Production total: −76
- erase-data.test.ts: −12
- New env-context.test pager table: about +45 (estimated: cursor, counted, full page, named page, repeated cursor)
- **Net: about −43 across 9 files**, not the −75 to −85 the candidate implies.

**Concepts:** 7 ways to list become 1 rule, plus one R2-bucket refusal that remains. This is scripts and deploy tooling, not runtime code, so the payoff is moderate.

## One expected-failure wrapper: createFlake and createFailing are copy-pasted and drifted, and expectFailure is unused

- Sweep index: 95; risk: low; payoff: 4/10
- LOC: About −250 net across 4 files, measured with wc:
- Source today: flake-test.ts 190 + failing-test.ts 239 = 429. Merged, about 245. That is about −185, including expectFailure's −18.
- Tests today: 287 + 279 = 566. Duplicated rows go (flake-test.test.ts 99-151 and 182-217, about −89) and the expectFailure rows go (−17), about −65 to −105 net after the shared table.

The per-area estimates ranged from −175 to −425. This figure sums source and tests honestly. (skeptic measured: Source today: flake-test.ts 190 + failing-test.ts 239 = 429. I wrote the merged draft and formatted it with oxfmt; it is 243 lines and keeps both contract docs and flakeSentinel. That is −186, including expectFailure's 24 lines.

Tests today: flake-test.test.ts 287 + failing-test.test.ts 279 = 566. These rows in failing-test.test.ts duplicate flake-test.test.ts:

- registration :13-45 (33 lines)
- Playwright :68-85 (18)
- mismatch :87-109 (23)
- hang :130-146 (17)
- the record-dir helper :244-265 (22)

The expectFailure rows at :223-242 add 21 more, and tabling costs about +10. Tests come to about −125.

Net is about −300 across 4 files, or 5 with the fixture unchanged.)

- Concepts: Before: 3 exported helpers, and the registration mechanism written twice with 2 detection rules.

After: 1 expected-fail registration with a kind switch, and 1 detection rule.

### Evidence

Merges four rows (packages-apps parallel and heavy, test-infra parallel and heavy).

The two wrappers are near copies:

- packages/shared/src/test-support/flake-test.ts:48-166 and failing-test.ts:68-215 each hold their own:
  - runner detection
  - body-vs-deadline race
  - record closure
  - toString fixture trick
  - vitest registration with retry 0 and a forced timeout
  - Playwright anonymous describe with retries 0
- Their comments point at each other ('same trick, and same reasoning, as failing-test.ts').
- Diffing the register blocks gives 186 lines for one mechanism.

The copies have drifted:

- vitest detection: flake-test.ts:133 `!('setTimeout' in test)` vs failing-test.ts:183 `'fails' in test`.
- option merging: flake-test.ts:139 `Object.assign({}, ...args.slice(1,-1))` vs failing-test.ts:190 `args.length > 2 ? args[1] : {}`.

expectFailure is dead:

- failing-test.ts:217-239 `expectFailure` has no caller outside its own two tests (`git grep`).

Usage:

- createFlake has one real user (apps/os/e2e/scheduled-appends-dormant.e2e.test.ts:27) plus flakeSentinel.
- createFailing has about 24–29 callers across apps/os, apps/agents and specs.

The tests duplicate too: flake-test.test.ts:99-151 and :182-217 mirror failing-test.test.ts:13-150.

### Current shape

Two wrappers of 120–150 lines each implement the same inversion trick. They differ only in:

- what a pass means
- the record's kind and outcome names
- createFailing's retry of non-matching failures

A third helper is exported, documented and tested, but unused.

### Proposed shape

```ts
function expectedFail<T extends (...a: any[]) => any>(
  test: T,
  pattern: RegExp,
  kind: "flake" | "failing",
  { timeoutMs = 30_000, retries = 0 } = {},
): T;
// matched failure → record(kind === 'flake' ? 'flake-fail' : 'pinned-fail'); rethrow            (green)
// pass → flake: record('pass'), throw 'Flaky test passed this run'                              (green)
//        failing: record('unexpected-pass'), log 'delete the wrapper', return                   (red)
// other failure / hang → record('unexpected-error'), log, return                                (red)
export const createFailing = (test, failure, options?) =>
  expectedFail(test, failure, "failing", options);
export const createFlake = (test, flake, options?: { timeoutMs: number }) =>
  expectedFail(test, flake, "flake", options);
```

- One detection rule: `'fails' in test`.
- One race, one record, one registration.
- flakeSentinel stays.
- Delete expectFailure and its rows.
- The duplicated registration, Playwright, hang and mismatch rows become one `test.for(['flake', 'failing'])`.

### What changes

- Nothing changes for real runners: both detection rules pick the same branch, and both option merges give the same object for vitest's call shapes.
- createFlake still never retries.
- Record kinds and outcome names are unchanged, so scripts/ci/flake-dashboard needs no change.
- A non-matching flake failure logs in the kind's wording.
- expectFailure is removed; nothing calls it.
- On 'spell it twice': that rule is about per-entity sagas, not a runner shim that already cross-references itself and has drifted.

### Pinned by

- packages/shared/src/test-support/flake-test.test.ts:22: a child vitest over flake-test-fixture/cases.vitest-target.ts runs both wrappers through vitest's real expected-fail machinery, and must stay green.
- failing-test.test.ts: all rows; the expectFailure rows at :226/:234 are deleted.
- flake-sentinel.test.ts, specs/flake-sentinel.spec.ts, apps/os/e2e/flake-sentinel.e2e.test.ts.
- scripts/ci/flake-dashboard/dashboard.test.ts (kind and outcome names).
- The call sites of both wrappers.

### Skeptic's amended proposal

Put one internal `expectedFail(test, pattern, kind: "flake" | "failing", { timeoutMs?, retries? })` in failing-test.ts. It uses one runner-detection rule (`"fails" in test`), one deadline race, one `record`, the toString trick, and one vitest branch (`{ ...callerOptions, retry: 0, timeout: timeoutMs + 1000 }`). It also keeps the one Playwright `describe(() => { describe.configure({ retries: 0 }); failer(...) })`.

Only the outcome handling depends on the kind:

- A matched failure records `kind === "flake" ? "flake-fail" : "pinned-fail"` and is rethrown.
- A pass under `flake` records `pass` and throws "Flaky test passed this run".
- A pass under `failing` records `unexpected-pass`, logs "delete the createFailing() wrapper" and returns.
- Any other failure, or a hang, records `unexpected-error`, logs with the `[${kind}-test]` prefix and returns.

createFailing keeps its retry loop through `options.retries`.

Keep both module paths so no import sites, doc links or dashboard.ts:107 links change:

- failing-test.ts exports `createFailing = (test, failure, options?) => expectedFail(test, failure, "failing", options)` and the core.
- flake-test.ts keeps `createFlake(test, flake, options?: { timeoutMs: number })`, a one-line call into expectedFail. Its narrow options type preserves the no-retry guarantee for flake-rate measurement. flakeSentinel stays in the same file, unchanged.

Keep `options.timeoutMs || 30_000` rather than a default parameter, so an explicit 0 behaves as it does today.

Delete `expectFailure` (failing-test.ts:217-239) and its rows (failing-test.test.ts:223-242).

Tests:

- Move the registration, Playwright, mismatch and hang rows into one `test.for(["flake", "failing"])` table with one record-dir helper.
- Keep the flake-only rows for pass and flake-fail.
- Keep the failing-only rows for the kind-failing record and the two retry rows.
- The child-vitest fixture row at flake-test.test.ts:22 stays as the real-machinery proof.
- Update the flake mismatch assertion at flake-test.test.ts:193 to the unified wording.

Before, there were 3 exported helpers and 2 copies of the registration mechanism with different detection code. After, there are 2 thin exported wrappers over 1 mechanism.

Risk is low. It is test-support code only. The child vitest run covers vitest's real expected-fail verdicts. specs/flake-sentinel.spec.ts and apps/os/e2e/flake-sentinel.e2e.test.ts cover the Playwright and e2e paths in CI. dashboard.test.ts pins the kind and outcome names.

### Skeptic's verdict

The claim holds against the code at b3daf4846. PR #3446 does not touch either wrapper; it only edits the body of the one createFlake row in scheduled-appends-dormant.

(a) The semantics really are almost identical. I checked each claimed drift against the real runners:

- **Runner detection.** In vitest 4.1.11, `test` has `fails` and no `setTimeout`. In Playwright 1.63, `test` and `test.extend()` have `setTimeout` and `fail` but no `fails`. So `!('setTimeout' in test)` (flake-test.ts:133) and `'fails' in test` (failing-test.ts:183) choose the same branch every time. The fakes in both test files agree with both rules too.
- **Option merging.** For vitest's `(name, fn)` and `(name, opts, fn)`, `Object.assign({}, ...args.slice(1,-1))` and `args.length > 2 ? args[1] : {}` give the same object. `(name, fn, timeoutNum)` is rejected by both, by the "last argument must be the test body" check.
- **So the "drift" is cosmetic.** It is not a live bug. The real argument for merging is history: 8893551d1 had to add the retries:0 describe pin to both copies. The comments also point at each other ("same trick, and same reasoning, as failing-test.ts").

What would actually change for createFlake:

- It would run through createFailing's retry loop, but with `retries` fixed at 0, which makes the loop a no-op. Keep createFlake's options type as `{ timeoutMs }` so a flake can never opt into retries; retries would bias the flake rate it exists to measure.
- The race timer becomes `deadline - Date.now()` instead of `timeoutMs`, and `durationMs` is taken inside `record`. Both differ by less than a millisecond.
- The log wording for a non-matching failure changes. The only thing that checks that text is flake-test.test.ts:193 (`/does not match the allowed flake pattern/`). Nothing in CI or the dashboard parses these strings; I grepped. uncontrolled-degradation.test.ts:14 and docs/testing.md:533 mention the `[failing-test]` prefix, and `[${kind}-test]` keeps it.
- Record kinds and outcome names are unchanged. dashboard.ts and evidence.ts key on them.
- `expectFailure` is dead. `git grep` finds it only in its own two test rows; the lint/oxlint-fixture.ts hits are an unrelated option name.

(b) The new shape really is simpler. It has one registration mechanism instead of two:

- runner detection
- race
- record
- the toString trick
- vitest retry/timeout pin
- Playwright anonymous describe

The kind switch sits in three small places: the name of the matched-failure outcome, whether a pass is green (throw) or red (log and return), and the wrapper name in messages. The merged contract is easier to explain than the two docs: "matched failure is green, any other failure or a hang is red, and a pass is green for a flake and red for a pin."

The "spell it twice" rule does not apply. That memory is about domain-entity create sagas in os-next, not a test-runner shim.

(c) No guarantee is dropped. Hang detection, `retry: 0` on vitest and `retries: 0` on Playwright, createFailing's bounded retry, record kinds and outcomes, and the fixture-source toString trick all stay.

(d) I re-measured LOC:

- **Source:** 429 lines today (flake-test.ts 190 + failing-test.ts 239). I wrote the merged file with both docs and flakeSentinel kept and formatted it with oxfmt: 243 lines. That is −186, and it includes expectFailure's 24 lines.
- **Tests:** 566 lines today (flake-test.test.ts 287 + failing-test.test.ts 279). failing-test.test.ts duplicates these rows:
  - registration :13-45 (33 lines)
  - Playwright :68-85 (18)
  - mismatch :87-109 (23)
  - hang :130-146 (17)
  - the identical record-dir helper :244-265 (22)

  The expectFailure rows at :223-242 are another 21 lines. Tabling the shared rows with `test.for` costs about 10 lines. That puts tests at about −125.

- **Net:** about −300 LOC. The candidate's −250 is conservative but honest.

It is test-support code, not product code, so the payoff is moderate. But this helper sits under about 25 pins, the flake sentinels and the CI telemetry, and it has visibly paid the "fix it twice" cost before.

I amended the proposal in one place. Keep both module paths so that about 16 import sites, 3 doc links and the dashboard's source links (dashboard.ts:107) do not change.

## The 'slice a wait into fresh calls' workaround for a replaced instance lives once, on the platform's call path, instead of three hand copies, one of them in userspace agents

- Sweep index: 96; risk: medium; payoff: 6/10
- LOC: About −110 source lines:
- agents collection: about −50
- apps/os project/collection.ts: about −57
- library.ts: about −35
- context-stub.ts: about +30

The measured spans were from before #3442, so re-measure. project/collection.test.ts (3 slice tests) moves to one context-stub test, roughly neutral. (skeptic measured: Spans that go:

- packages/agents/src/collection.ts:23-28 and 224-270: 6 + 47 = 53
- apps/os/src/project/collection.ts:16-31 and 57-103: 16 + 47 = 63
- apps/os/src/library.ts:330-342 and 376-447: 13 + 72 = 85, plus `waitForEventOnContext` (context-stub.ts:100-124, 24 lines) if folded in
- apps/os/e2e/support/config-worker.ts:10-26: about 15

Additions:

- context-stub.ts: about +50
- call sites: about +10

Net: about −130 to −150 source lines.

Tests:

- project/collection.test.ts (135 lines) and library.test.ts:332-430 are rewritten as one context-stub.test.ts set, net about −50 to −100.)
- Concepts: Before, 8:
- 3 slicers
- 5 slice and answer constants
- 2 warn events
- the woken-rides-the-filter trick

After, 2: one slicer on the platform's call path, and one constant pair.

### Evidence

Checked at HEAD ce251e06c. #3442 rewrote parts of both collections, but the slicers remain.

The three copies:

- packages/agents/src/collection.ts: CERTIFICATE_WAIT_MS and CERTIFICATE_WAIT_SLICE_MS at :23-28, with the comment '…project/collection.ts TERMINAL_WAIT_SLICE_MS says why', and agentCertificate at about :226-270. It adds `itx/woken` to the type filter and has its own warn.
- apps/os/src/project/collection.ts:31 TERMINAL_WAIT_SLICE_MS, with #terminalFact at about :53-100 and the warn `iterate-context.platform-failure-wait-moved` at :94.
- apps/os/src/library.ts:337-342 SCRIPT_RUN_WAIT_SLICE_MS and SCRIPT_RUN_SLICE_ANSWER_MS, with settlementOfScriptRun at about :380-447 (a fresh stub per slice). Its doc says 'as it costs the entity collection's'.

The common path:

- Every cross-context call already goes through contextStub (src/context-stub.ts:21-35, reached from stateless-context.ts:84-94).
- contextStub already special-cases `itx.run` settlements.
- IDEMPOTENT_CALLS already lists waitForEvent.

Long waits nobody sliced are still exposed:

- packages/agents/src/install.ts:94 upgradeAgents (120 s)
- packages/voice/src/install.ts:107 and :207 (60 s and 120 s)
- the agent system prompt's `waitForEvent({… timeoutMs: 60000})` (system-prompt.ts:32 and :44)

### Current shape

The Cloudflare fault leaves a call on a replaced Durable Object instance. Three callers each hand-roll a loop around it: short waitForEvent slices, WAIT_TIMEOUT meaning 'go again', and in two of the copies `itx/woken` riding the filter so the move can be logged. One of those copies is a userspace package that carries the platform's fault workaround and its log line.

### Proposed shape

```ts
// apps/os/src/context-stub.ts, in invoke()
if (isWaitForEvent(itxExpression))
  return waitInSlices(filter, (slice, givenUp) =>
    freshStub().invoke(["itx", "builtins", ["waitForEvent", slice]], [], caller, givenUp),
  );
// waitInSlices: until filter.timeoutMs, ask with timeoutMs = min(5_000, left); WAIT_TIMEOUT → next slice;
// a slice unanswered after 20 s is released and asked again (SCRIPT_RUN_SLICE_ANSWER_MS's rule); one platform warn line
```

Then:

- agentCertificate and #terminalFact each become one `context.waitForEvent({ type, afterOffset, timeoutMs })`.
- settlementOfScriptRun becomes one `waitForEvent({ type: run-settled, payload: { requestOffset }, afterOffset, timeoutMs })`.

### What changes

- Every cross-context wait now heals from a replaced instance: upgrades, voice install and the model's own scripts, not just the three hand-picked ones.
- A long wait costs one call per 5 s. A 120 s wait is 24 subrequests, which matters under the 1000-subrequest cap of one long invocation.
- The two `*.platform-failure-wait-moved` events become one platform line, and the woken-in-filter trick goes.
- A final WAIT_TIMEOUT carries the platform's generic message instead of 'agent <path>: no … within 30000ms'.
- The 'remove when the fault is fixed' note lives in one place.

### Pinned by

- apps/os/src/project/collection.test.ts (3 slice rows)
- src/library.test.ts (settlementOfScriptRun slices, wait-unanswered)
- the #3428 e2e row (a script run interrupted when its instance is replaced)
- the apps/agents e2e create and delete rows

### Skeptic's amended proposal

Put one slicer on the platform's call path, at the hop that reads run settlements (`readsRunSettlements` true). Its scope is `waitForEvent` with an explicit `afterOffset`. It is found by the same step parse as `isIdempotentItxCall`. Relay hops and waits with no offset go through unsliced, exactly as today.

```ts
// context-stub.ts
const WAIT_SLICE_MS = 5_000; // + the WORKAROUND doc moved from project/collection.ts
const WAIT_SLICE_ANSWER_MS = 4 * WAIT_SLICE_MS;

// in invoke(), before the single call:
const wait = readsRunSettlements && explicitWaitOf(itxExpression, args); // { prefix, filter } | undefined
if (wait)
  return waitInSlices(
    wait.prefix,
    wait.filter,
    Math.min(wait.filter.timeoutMs ?? WAIT_DEFAULT_MS, WAIT_CAP_MS),
    caller,
    givenUp,
  ); // limits exported by stream.ts

// the run settlement: one filtered wait, which drops the skip-other-runs loop
const settled = await waitInSlices(
  ["itx", "builtins"],
  {
    type: "events.iterate.com/itx/run-settled",
    payload: { requestOffset },
    afterOffset: requestOffset,
  },
  RUN_DEADLINE_MS + 60_000,
  { principal: null },
  givenUp /* on the context at path */,
);
```

`waitInSlices`:

- Asks `[...prefix, ["waitForEvent", { ...filter, timeoutMs: min(WAIT_SLICE_MS, left) }]]` once per slice, on a fresh stub.
- A WAIT_TIMEOUT means the next slice.
- A slice unanswered after WAIT_SLICE_ANSWER_MS is released and asked again, as today's run reader does.
- It warns once, `iterate-context.platform-failure-wait-moved`, when the answering event's `createdAt` is older than the end of a slice that timed out before it. This keeps the recovery observable without the woken-in-the-filter trick.
- At the deadline it throws WAIT_TIMEOUT with the total time and the offset.

The callers then shrink:

- `agentCertificate` and `#terminalFact` each become one `context.waitForEvent({ type, afterOffset, timeoutMs: 30_000 })`.
- `publishConfigWorker`'s loop becomes one call.
- `settlementOfScriptRun` shrinks to decoding the settlement.

Report the userspace change in packages/agents as its own line in the PR.

### Skeptic's verdict

Checked at b3daf4846, which already includes #3446 and #3442.

**The claim holds, and there are four hand copies, not three.** Each one slices a wait into 5 s calls on a fresh stub to get round the same Cloudflare fault:

- packages/agents/src/collection.ts:23-28 and 224-270 (`agentCertificate`)
- apps/os/src/project/collection.ts:16-31 and 57-103 (`#terminalFact`)
- apps/os/src/library.ts:330-342 and 376-447 (`settlementOfScriptRun`)
- apps/os/e2e/support/config-worker.ts:5-26 (`publishConfigWorker`, a fourth copy the candidate missed)

**Where the calls go.** The two collection waits (`itx.cd(path).waitForEvent`) already go through the stateless resolver's `located`, then `contextStub` (context/stateless-context.ts:84-94). `contextStub` already gets a fresh stub on every attempt and already reads run settlements (context-stub.ts:21-99). So one slicer there would heal every copy without the callers knowing. That removes a platform workaround and its log line from a userspace package, which matches "safety mechanisms invisible to user code".

**#3446 is not in the way.** It deleted two more hand slicers on purpose, in `upgradeAgents` and `upgradeVoice`. It does not do this centralisation.

**The candidate's sketch is wrong in four places:**

1. **Waits without `afterOffset` must not be sliced.** In stream.ts:642-652, a wait without `afterOffset` pins the head at call time, and a slicer cannot know that head. Asking again moves the head forward. In exactly the fault case it loses what the new instance appended during the stuck slice. So slice only when `afterOffset` is given. Every copy today passes it, and so do the system prompt's and the install waits.
2. **The stream's limits must stay.** The stream defaults a wait to 30 s and caps it at 120 s. The slicer must keep that cap for public waits, or a `timeoutMs` of an hour becomes 720 subrequests. The run settlement's 11-minute wait (RUN_DEADLINE_MS + 60 s) therefore goes through the slicer's internal entry, not through a public `waitForEvent`.
3. **Recovery must stay observable** (the engineering invariant). Dropping the `itx/woken`-in-the-filter trick drops the only sign that the healing happened. That trick does not generalise, because a payload filter never matches the wake record. Replace it with one generic warn, emitted when the answering event's `createdAt` is older than the end of a slice that timed out before it.
4. **Slice only at the hop that reads run settlements** (the edge and stateless hops, `readsRunSettlements` true). A Durable Object that relays a call should pass the wait through, just as it passes a run request through. This avoids nested timers.

**What changes, the "almost":**

- **Every other explicit-offset wait is now sliced.** That includes the model's scripts, the upgrade and voice-install waits, the CLI, and e2e runs over the WebSocket.
- **More subrequests.** An idle wait costs one subrequest per 5 s: a 120 s wait is 24 instead of 1. That counts against the 1000-subrequest cap of a capnweb WebSocket, which is one request.
- **Ephemeral events can be missed between slices.** An ephemeral event that matches in the millisecond gap between two slices is never delivered, because a re-armed wait only scans the durable log. No first-party caller waits on an ephemeral type.
- **Every wait gets the 20 s unanswered-slice give-up.** Today only the run reader has it.
- **The timeout message becomes generic.** A final WAIT_TIMEOUT no longer names the entity or agent. project/collection.test.ts pins that text.
- **The "move" warns become one warn.** The two `*.platform-failure-wait-moved` warns and `itx-run.platform-failure-wait-unanswered` become one platform warn line.
- **A rewritten name is sliced as spelled.** If a rewrite rule points `waitForEvent` at user code, that code is sliced as the caller spelled it. `IDEMPOTENT_CALLS` takes the same stance.

**LOC, re-measured with sed and wc:**

| File                              | Lines removed                                       |
| --------------------------------- | --------------------------------------------------- |
| packages/agents/src/collection.ts | 53                                                  |
| project/collection.ts             | 63                                                  |
| library.ts                        | 85, plus 24 in `waitForEventOnContext` if folded in |
| config-worker.ts                  | about 15                                            |

Additions:

- The call sites become one wait each: about +10 lines.
- context-stub.ts: about +50 lines, including the moved workaround doc.

Net: about −130 to −150 source lines. On the test side, project/collection.test.ts (135 lines, 3 slice rows) and library.test.ts's slice rows (:332-430) are rewritten as one context-stub.test.ts set, a net loss of about 50–100 lines.

**Concepts:**

- Before, 14: 4 slicers, 6 constants, 3 warn events, and the woken-in-the-filter trick.
- After, 4: one slicer, 2 constants, and one warn.

**Risk: medium.**

- The code sits on `contextStub.invoke`, the path every cross-context call takes.
- No test can raise the real fault, so only unit rows with fakes and the #3428-style Workers row (**workers-tests**/context-runs.test.ts "REPLACED MID-RUN") pin it.
- The subrequest cost on long WebSocket sessions is real.

**Guarantees:** none are dropped if the amendments above are kept. Loop-guard causes ride unchanged on each slice.

## 'Unknown' flake records are written once, by the finalizer, from the artifacts it already reads, instead of per runner and then reconciled

- Sweep index: 97; risk: low; payoff: 4/10
- LOC: About −50 to −140 net in one PR.
- Source: about −25 (reporter loops 9+13, schema 3, check 2, fake 1, finalizer +3).
- Tests: about −25 to −115, depending on how many reporter rows collapse into one finalizer assertion. Affected:
  - the two 'failed every attempt leaves an unexpected-error flake record' rows (47+52 lines)
  - the unknown halves of the retried-pass rows
  - the evidence mismatch case (−7) (skeptic measured: Measured by drafting the change on scratch copies of the 11 files (diff: 25 lines added, 190 removed, net −165).

Source, −28:

- packages/shared/src/test-support/e2e-policy/retry-telemetry-reporter.ts: 273→262 (−11)
- scripts/ci/playwright-telemetry-reporter.ts: 141→127 (−14)
- packages/shared/src/test-support/flake-suite-summary.ts: 43→40 (−3)
- scripts/ci/flake-dashboard/evidence.ts: 210→207 (−3)
- scripts/monitors/fake-depot.ts: 227→226 (−1)
- scripts/ci/flake-suite-summary.ts: 135→139 (+4)

Tests, −137:

- retry-telemetry-reporter.test.ts: 249→187 (−62, including a new `fails: true` table row)
- playwright-telemetry-reporter.test.ts: 256→185 (−71)
- flake-dashboard/evidence.test.ts: 135→128 (−7)
- flake-dashboard/dashboard.test.ts: 517→516 (−1)
- scripts/ci/flake-suite-summary.test.ts: 255→259 (+4, a new assertion on the written file)

Not counted: prose touch-ups in flake-record.ts, docs/testing.md, docs/test-evidence.md and the evidence.ts header, roughly 0 net. Narrowing RetriedTestTelemetry would be another −15 or so.)

- Concepts: Before: a writer in each of 2 runner kinds, a summary count, and a reconciliation diagnostic.

After: the finalizer writes the records.

### Evidence

Merges three rows: packages-apps parallel, and test-infra parallel and heavy.

The records are written per runner:

- packages/shared/src/test-support/e2e-policy/retry-telemetry-reporter.ts:173-181 (vitest) and scripts/ci/playwright-telemetry-reporter.ts:9-12 and :69-77 each loop `unknownFlakeRecordFromTelemetry(record)` into `appendFlakeRecord`, one file per pid.
- The same telemetry is also written as each runner's artifact (retry-telemetry-reporter.ts:203-219).

The finalizer derives them again, only to count them:

- scripts/ci/flake-suite-summary.ts:122-123 runs the same function over the same artifacts to fill `unknownFlakeCount` (field declared at packages/shared/src/test-support/flake-suite-summary.ts:27-29).

The dashboard reconciles the two:

- scripts/ci/flake-dashboard/evidence.ts:163-164 marks a run incomplete when the counts disagree ('Unknown flake records do not match the full runner result').
- scripts/monitors/fake-depot.ts:139 fakes the field.

Every evidence-keeping job runs the finalizer with --flake-suites: test.yml:100, preview-os.yml:347, main-os-e2e.yml:208.

An alternative (test-infra parallel) derives unknowns in the dashboard from suite-summary rows. That deletes more (about −170) but changes the channel, and runs with no summary lose their unknowns (medium risk).

### Current shape

The same derived record is produced twice: in each runner process, and again as a count in the finalizer. A reconciliation check exists only to catch the two disagreeing.

### Proposed shape

```ts
// scripts/ci/flake-suite-summary.ts, beside suite-summary.json
const unknown = tests.flatMap((t) => unknownFlakeRecordFromTelemetry(t) ?? []);
await writeFile(
  join(directory, "unknown.jsonl"),
  unknown.map((r) => `${JSON.stringify(r)}\n`).join(""),
);
```

- Delete both reporter loops and the Playwright reporter's flake-record import.
- Delete `unknownFlakeCount` from the schema, the finalizer and fake-depot.
- Delete evidence.ts:163-164.
- `appendFlakeRecord` stays for createFlake and createFailing.
- The dashboard already reads every `*.jsonl` in `flake-records/<suite>/`.

### What changes

- The records are the same (name, outcome, error, `at`), written by one process into one file.
- A runner killed before its end hook loses its unknowns, as today. The completeness check still flags it.
- The 'records do not match' diagnostic disappears, because the two copies can no longer disagree.
- Old R2 runs still parse: zod ignores the extra key, and per-pid lines are still `*.jsonl`.
- Jobs without `--flake-suites` never set FLAKE_RECORD_DIR, so nothing is lost there.

### Pinned by

- retry-telemetry-reporter.test.ts: :28 (30-34, 59-70), :97, :117-134
- playwright-telemetry-reporter.test.ts: :15 (19-20, 84-97), :135
- flake-dashboard/evidence.test.ts:121-130
- scripts/ci/flake-suite-summary.test.ts:56-60
- dashboard.test.ts:484
- flake-record.test.ts keeps pinning the function, unchanged

### Skeptic's amended proposal

Write the kind "unknown" records once, in writeFlakeSuiteSummary (scripts/ci/flake-suite-summary.ts), from the `tests` array it already builds. Put them beside suite-summary.json:

```ts
await writeFile(join(directory, "suite-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
// Each plain test that failed, a retried pass or a hard failure, as a kind "unknown" flake record.
const unknownFlakes = tests.flatMap((test) => unknownFlakeRecordFromTelemetry(test) ?? []);
await writeFile(
  join(directory, "unknown-flakes.jsonl"),
  unknownFlakes.map((record) => `${JSON.stringify(record)}\n`).join(""),
);
```

Delete:

- the loop at retry-telemetry-reporter.ts:173-181 and its import on line 2;
- the loop at playwright-telemetry-reporter.ts:69-77 and its import at lines 9-12;
- `unknownFlakeCount` in the schema (flake-suite-summary.ts:27-29), in the finalizer (:122-123), at fake-depot.ts:139 and at dashboard.test.ts:484;
- the check at evidence.ts:163-164 and its "uncounted" case in evidence.test.ts.

Keep appendFlakeRecord and FLAKE_RECORD_DIR for createFlake and createFailing.

Tests:

- Drop the two "failed every attempt leaves an unexpected-error flake record" rows and the flake-record halves of the two retried-pass rows.
- Add one assertion to flake-suite-summary.test.ts's "per-test evidence" row that unknown-flakes.jsonl holds [retry → retried-pass, failure → unexpected-error].
- Add a row `{ mode: "run", fails: true, state: "passed", reason: "passed", expectedState: "failed" }` to the vitest reporter's expectedState test.for table. The deleted vitest row is the only pin on that mapping today.

Update the prose that says "the telemetry reporters" write the records:

- the flake-record.ts header (lines 13-19);
- the doc comments of both reporters;
- evidence.ts:14-17 and :124-128;
- docs/testing.md:245 and :525;
- docs/test-evidence.md:54.

Optionally, type unknownFlakeRecordFromTelemetry's parameter as TestTelemetryRecord and delete the RetriedTestTelemetry interface, which existed so the function could accept both reporters' shapes.

Pinned by:

- retry-telemetry-reporter.test.ts:28-95 and :97-141;
- playwright-telemetry-reporter.test.ts:15-98 and :135-186;
- evidence.test.ts:86-117;
- flake-suite-summary.test.ts:31-66;
- dashboard.test.ts:484.

flake-record.test.ts is unchanged.

### Skeptic's verdict

The semantics claim holds. I checked it against the code on origin/main at b3daf4846. PR #3446 does not touch any of these files; it only reshards specs from 11 to 10.

(a) The records come out identical.

- The finalizer loads the same artifacts the reporters wrote, parsed through TestTelemetryRecord. That schema keeps every field unknownFlakeRecordFromTelemetry reads: leafName, expectedState, outcome, state, passedAfterRetry, durationMs, startedAt and firstFailure.
- Records land in the same directory, test-results/flake-records/<suite>. The finalizer writes to resolve(artifactRoot, "../flake-records")/<suite>, the same path FLAKE_RECORD_DIR points at in test.yml:65 and preview.ts:695/701.
- Every job that sets FLAKE_RECORD_DIR finalizes with a matching --flake-suites: test.yml gives unit, and the e2e and specs-shard jobs in both e2e workflows use their FLAKE_SUITE. os-real-model sets no FLAKE_RECORD_DIR. preview.ts strips it from warm-up spawns.
- The finalizer's per-suite artifact filter matches the runners that write records today. The unit job runs only vitest, so everything there is testKind "unit".
- Nothing else reads the per-pid unknown lines. dashboard.ts is the only consumer, and it reads every *.jsonl under the suite directory.

What actually changes:

1. `at` falls back to the finalize time instead of the runner's end time. This only happens when startedAt is missing, which does not occur for a test that ran and failed.
2. If the finalizer throws before writing the summary, today's per-pid unknown lines still upload but new ones would not be written. The throw points are no depotJobUrl, no headSha, a malformed or duplicate artifact, or a FlakeSuiteSummary.parse failure. All of these are already a broken job on Depot.
3. appendFlakeRecord swallows write errors, so a record can be lost silently today; that is what the count check catches. A failed writeFile in the finalizer fails the step instead, which is better.
4. The "records do not match" diagnostic disappears. It was added in #2658 only to catch a lost record between the two channels. Once the records and the count come from one function over one array, they cannot diverge.

Old summaries still parse: FlakeSuiteSummary is a stripping z.object, and the dashboard only looks back 8 days anyway.

(b) The new shape is simpler. There is one derivation instead of two plus a reconciliation. The reporters go back to their stated contract ("Reporters only write this artifact"). The Playwright reporter loses its dependency on shared flake-record.

(c) No guarantee is dropped. Completeness is kept by construction. The malformed-line check and the manifest-last upload gate stay.

(d) I re-measured by drafting the change on scratch copies (diff: 25 lines added, 190 removed, net −165).

- Source −28: vitest reporter −11, Playwright reporter −14, schema −3, evidence.ts −3, fake-depot −1, finalizer +4.
- Tests −137: vitest reporter test −62, Playwright reporter test −71, evidence.test −7, dashboard.test −1, flake-suite-summary.test +4.
- The candidate's "−50 to −140" undercounts; the real total is −165.

One mis-specification: deleting the vitest "failed every attempt" row drops the only pin that `fails: true` maps to expectedState "failed". Keep it with one extra row in the existing test.for table.

Concepts drop from 4 to 1: two runner-side writers, the unknownFlakeCount field and the reconciliation diagnostic become one finalizer write.

Risk is low. The code is peripheral CI plumbing, and nearly all the deleted lines are tests, so the payoff is moderate.
