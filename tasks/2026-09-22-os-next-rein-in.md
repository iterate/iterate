---
state: in-progress
priority: high
size: large
tags: [os-next, cleanup, simplification, docs, sdk, dash, agents]
---

# os-next rein-in: what yesterday's 41 PRs left behind, and the PRs that take it back

Read-only audit of origin/main 5a7160250 (2026-09-22) by six reviewers, one per area, each reading
whole files and grepping callers. Full reports (with line numbers for every claim) are in the
`/private/tmp/claude-501/-Users-jonastemplestein--herdr-worktrees-iterate-mcp-server/8fd3b677-eec5-45d0-9dee-cabe8bb5e48e/scratchpad/rein-in/{A-context-core,B-stream,C-entities,D-control-plane,E-sdk-ui-apps,F-docs-tests}.md` (the three giant docs are fact-checked claim by claim in the F reviewer's sub-report, folded into §4).
This file is the plan: the design calls first, then the delete list, the comment sweep, the docs
sweep, and a PR sequence.

Numbers for scale. Yesterday: 294 files, +21,108 / −7,418 lines. `apps/os-next/src` is 33k lines
(20.6k non-test). Of the lines added to `src` yesterday, 24% are comments. 356 comment lines in
`src` carry two or more shouted words. 47 of 68 source files open with a banner that names the file
itself; the longest banner blocks run 21 to 34 lines before the first import.

## 1. The design calls (what is inconveniently designed, and the fix)

Ranked by how much they cost to keep. Each names the file, the awkwardness, the shape after, and
the honest LOC delta. "Spell it twice" is Jonas's rule; where it has become spell-it-six-times the
call is to make it one thing, and where it is genuinely twice the call is to leave it.

### 1.1 The entity pattern is one pattern copied three to six times (≈ −420 lines)

`src/{repo,workspace,agent}/{contract,processor,durable-object,collection}.ts`. Measured with
`diff` after normalising the entity word:

| fragment | copies | lines each | identical? |
|---|---|---|---|
| `collection.ts` (`list`/`create`/`delete` door) | 3 | 110 | yes, modulo the entity word and wrapping |
| lifecycle state schema (`creation`/`deletion`) | 3 | 18 | yes |
| lifecycle reduce (five cases) | 3 | 30 | yes, modulo slug |
| the parent-link write (#2787) | 3 | 16 | yes |
| certificate literal + `appendTo("/")` + `append` | 6 | 7 | yes |
| saga scaffolding (caughtUp gate, flags, `create-failed` catch, `finally`) | 3 | ~30 | yes |
| secret catalog schema | 3 | 13 | yes |
| secret catalog reduce (`secret/set`, `secret/deleted`) | 3 | 19 | yes |
| `["oauth-refresh-token","waitrose-session"]` enum | 6 | 1 | yes |
| apex ingress target literal (`project/processor.ts` 178 and 269) | 2 | 20 | yes, same file |

Of ~766 lines of pattern, ~570 are copies. What is genuinely different per entity is small: the
repo saga's `cfArtifacts.create/delete` (12 lines), the agent saga's `#assertSandbox` + system
prompt (12 lines), the workspace saga's nothing, and the DO verbs.

The shape after:

- **One collection door.** `src/project/collection.ts` exporting `EntityCollectionRpcTarget`
  constructed with the slug (`"repo" | "workspace" | "agent"`), `withItx`, and the catalog thunk.
  `project/durable-object.ts` memoises one per slug. `first-party-facets.ts` and `library.ts` are
  untouched (they dispatch by name). 350 → ~125 lines. Low risk: the three e2e suites pin every branch.
- **One secret catalog.** `secret/contract.ts` exports `SecretRefreshKind`, `SecretCatalog` and a pure
  `reduceSecretCatalog(secrets, event)`; project, account and organization spell
  `secrets: SecretCatalog.default({})` and one two-case delegation. `SecretCatalogEntry` in
  `secrets.ts` becomes `z.infer` of it. ≈ −55.
- **One lifecycle schema.** `EntityCreationAndDeletionState` exported from `project/contract.ts`
  (which already imports all three contracts). Whether the five-case reduce is shared too is the
  one place this plan crosses the "no shared saga helpers" line for a *reduce*, not a saga; the
  recommendation is to share the schema (−33) and leave the reduce spelled unless Jonas says otherwise (−48 more).
- **The parent link once.** With the collection shared, the 16-line link write can move to
  `EntityCollectionRpcTarget.create()` right before `create-requested`, still before the
  certificate, still keyed `itx@<creator>`; `creator` then leaves three payloads, three states and
  three reduces (≈ −51). Check first: the saga writes the row through the facet's loopback with no
  principal; the collection would write it under the project facet's `withItx`. If the rewrite-rule
  row must be the platform's, keep the three copies.
- **The ingress target literal once** in `project/processor.ts` (`configRepoIngressTarget(commitOid)`,
  two callers in one file). −28.
- The saga bodies, the five event declarations per contract, and the DO `#created()` guards stay spelled.

### 1.2 Eleven ways to ask "which origin am I on" (≈ −25 lines, −2 exports, one story)

`platformOriginOf(config, request)` has 11 call sites, six of them the literal
`platformOriginOf(appConfigOf(env), request)`; `oauthAddresses(env, platformOrigin)` re-derives
`{ issuer, api, mcp }` in 7 files, where `issuer` is `platformOrigin` renamed; the DO persists it in
kv and reads it back through `#platformOriginNow()`, which always equals the field it shadows;
`IngressRouting` is declared three times (`project-ingress.ts`, `app-config.ts` identical,
`envs.ts` inline); `registrableDomainOf` exists twice with different semantics; the MCP address is
spelled five ways (`envs.mcpBaseUrl`, `urls.mcp`, `oauthAddresses().mcp`, `info().mcpOrigin`, e2e `MCP_BASE_URL`).
The edge computes the origin once in `worker.ts` and then every door it calls recomputes it.

After: one `platformAddressesOf(env, request): { platformOrigin, api, mcp }` in `app-config.ts`
(drop the `issuer` alias; say once that the platform origin is the issuer); doors that hold a
string take the object; `IngressRouting` lives once in the SDK; delete `#platformOriginNow` and the
generator's second `registrableDomainOf`.

### 1.3 Cursor rows remember a pushed batch that the stream's ring already keeps (≈ −95 lines, a real bug)

`src/stream/subscription-delivery.ts`. `record.pushedEventBatch` + `lastDeliveredThroughOffset`
for cursor rows + the contiguity/at-mark test exist because "the log has no ephemerals; the push
does". Since #2651 (2026-09-16) the stream keeps the recent-ephemerals ring and
`Stream.read(after, limit, { includeEphemeral: true })` returns them in offset order. The memo
predates the ring and was never revisited; #2757 patched it instead. The memo holds one batch,
latest wins, so two ephemeral commits during one in-flight cursor call drop all but the newest.

After: `#drainCursor` reads with `includeEphemeral: true` and never looks at a pushed batch; the
in-memory cursor already advances past the durable mark on an ephemeral-only ack, so re-reads
return only newer ephemerals. `onCommit`'s cursor branch shrinks to "kick the loop". Vanishes: the
field, the memo write, the stale/contiguous/at-mark logic, the ceiling-min, the ten-line comment,
and the `cursor-rows-pushed-ephemerals` scenario's unbounded retention. Decide, not hide: the ring
holds 1 MiB and drops an event over the whole budget; a cursor target would miss a single
ephemeral over 1 MiB that today's memo carries. No cursor consumer does that (grepped).

Also in this file: `#cursorDeliveryRunning` (a Set) and `#cursorDeliveryLoops` (a Map) are two
spellings of one lock; the comment justifying the Set ("so `deadlines()` reads it true") is false,
`deadlines()` never reads it. −6.

### 1.4 The core live-state has no reader (≈ −45 lines and an O(state) diff per commit)

`Stream` builds a `LiveState` for the core state, tracks `coreReducedStateChanged` through the
commit, and exposes `coreLiveStateSnapshot()` which the DO wires as `itx.facets.get('core').liveSnapshot()`.
Nothing calls it: the dash reads the `project` facet, the agents app reads `agent`, voice reads
`voice-agent`, every e2e reads `get('core').snapshot()`. `LiveState.orderDeltaAppends` (20 lines
and a paragraph in the SDK's `processor.ts`) exists only for this holder. Delete all of it; a dash
view of core state later is a `snapshot()` poll or a real processor.

### 1.5 The durable object is a god file with one real seam left (DO 1644 → ~1200)

`src/iterate-context-durable-object.ts`. The header says "the wiring and the doors"; a quarter of it
is the lifecycle of hosted facets (lines 1153–1430 plus claims/backoff, the live set, the
platform-failure predicate and the `facets.get` closure): startup memo in kv, loaded identity and
restart marker, cold-start class minting, platform-failure restart, watchdog, result copy and
dispose, alarm claims with a backoff ladder, delete. Its inputs are the same shape
`RpcStubDirectory`, `SubscriptionDelivery` and `AlarmCoordinator` already take; those three
extractions made the file readable and the facets were left behind.

After: `context/facet-host.ts` (`class FacetHost`, ~405 lines with its deps type), the DO keeps
one-line forwards; inside, split the 185-line `#invokeFacet` into materialise and call. Move
`#rewriteRuleList` (80 lines, a pure function of own rules, implicit roots and an inherit thunk) to
`itx-expression-rewriting.ts` as `describeRewriteRules` and test it in the table instead of workerd.
**Do not split further**: the deps block is the wiring; the runner and the alarm pass are doors.

Small duplications inside the DO: `this.#callerStorage.getStore() ?? { principal: null }` ×5 (one
getter); `getByName(DurableObjectNameCodec.stringify(...))` ×3 (the existing `context(p)` dep).

### 1.6 library.ts is one file for a reason that is three lines of test (≈ −50, three files out)

The header says "ONE file the boundary test reads whole"; `library.test.ts` does
`readFileSync("./library.ts")` and regexes imports, and would do the same over a glob. The
header's central claim (a library module takes `itx` and nothing else, so it could move to
userspace unchanged) is false for five of nine roots: `run`, `repos`, `workspaces`, `agents`,
`mcpConnections` spell `itx.builtins`, a word loaded code is forbidden to say; the file admits this
at line 519. Only the three connectors and `files` pass the litmus.

After: `src/library.ts` keeps types, `buildLibrary`, run, entities, files (~600 lines, honest
header); `src/library/{capnweb,mcp,openapi,connection}.ts` (173 / 292 / 270 / 56). The three
12-line entity essays in `LibraryRoots` restate the entity folders' headers; cut to three lines
each. `LibraryItx` picks seven members and uses three.

### 1.7 Row admission happens at the wrong door (a real hole, −12)

`refuseSelfLoopRow` runs only on the itx door (`built-ins.ts` append). The DO's own `append`,
`#localContext.append`, alarm batches, pager attaches and run settlements reach
`#appendAndRunCommittedEffects` without it; its docstring "the append door refuses it, whoever
appends" is untrue. Worse: a sibling appending `itx ⇒ itx.builtins.cd('/x')` to `/x` is checked
against the *sibling's* path, then lands on `/x` unguarded, which is exactly the loop the guard was
written for. After: `normalizeControlEvent(event, ownPath)` calls it in its rewrite-rule branch;
`admitLoadedCodeRow` stays on the itx door (it needs `caller.app`). A third loop guard in
`library.ts` (`createEntity`, two-context cycle) and the rewriting docstring contradict each other
about whether two contexts pointing at each other is a misconfiguration; pick one sentence.

### 1.8 One validation convention inside the core fold (−30, one boundary)

`core-processor.ts` zod-parses `run-*` and `schedule-*` payloads inside the reduce and casts every
other control event, trusting `normalizeControlEvent`; `RunRequested` is parsed three times per
event (boundary, fold, DO runner). Its own header says "no zod on the DO script", and the file
imports zod. Pick: parse at the one boundary, cast in the fold. Same file: the predicate "is
`resolved` = `itx.builtins.<registry>.get(<string>)`" is hand-spelled three times plus a fourth in
rewriting.ts (one `builtInsGetStep(resolved, registry)`); the `hostedFacet` marker spread with its
oxlint comment is built three times from a spec that already is the marker minus `source` (one destructure).

### 1.9 agent/processor.ts is 1,137 lines because 250 of them are an HTTP client (0 net, −42 optional)

Lines 173–291 and 1004–1136 are SSE framing, usage-dialect normalisation and the Responses API's
event names for two providers. Move them to `agent/model-call.ts` as one function; the reduce and
loop (~450 lines) read well and stay. Decide: the `@cf/` route and the whole-answer `ChatAnswer`
parse (42 lines) are exercised only by the e2e fake `ScriptedAi`; the default model is `gpt-6-astra`
and no first-party code sets a `@cf/` model. Either the fake speaks the Responses route or the
header says the route exists for the local story; today it reads as two supported products.

### 1.10 app-config.ts narrows by hand what the schema could say (−50)

`ingressRouting` is a plain `{type, hostname}` in the schema, hand-narrowed into a discriminated
union (15 lines), the `AppConfig` type rebuilt with two `Omit<>`s (9 lines), the union re-declared.
Make the schema `z.discriminatedUnion("type", ...)`. One catch, verified: `packages/shared/src/config.ts:333`
throws when an override value is an object under a non-`ZodObject` schema, and
`APP_CONFIG_URLS__INGRESS_ROUTING='{"type":"paths"}'` is that; add `ZodDiscriminatedUnion` beside
`ZodRecord` at its early return. `warnUnknownKeys` (25 lines to warn) becomes `.strict()` on three
objects, which refuses at boot naming the key, which is what the header says it wants (check the prd
blob in Doppler first). The local-dev `urls.os` + `subdomains/localhost` pair is spelled in
`wrangler.base.jsonc`, the generator, `dev.ts` and `e2e/support/worker-config.ts`; keep the base jsonc.

### 1.11 worker.ts and the auth files: a door list with two things that are not doors (−18, moves)

The 13-door dispatch reads top to bottom. Above it: `secretOwnerOf`, `reachesSecretOwner`,
`secretOAuthCallback` (102 lines, the secret-OAuth callback's admission) belong beside
`secret-oauth.ts`; `registerPipelinedRpcBrand` belongs with `ItxEntrypoint`. The `auth.require` gate
at 404–419 dates from when `/` was the console; after the `/api*` 404 every remaining platform-origin
path is either an open issuer route or a 404, so the gate turns a signed-out `GET /nonexistent` into a
login redirect and protects nothing; no test asserts it. `control-plane.ts` is misnamed (it holds
`Env`, `Handler` and the issuer's three pages; the control plane proper is api/oauth/mcp/directory);
`worker.ts:421` claims it "lists its handlers: the OAuth AS, /mcp", which is false. Rename to
`issuer-pages.ts`, `Env`/`Handler` to `env.ts`. `login-code.ts` also holds the password; name it for both.

Auth is one story (every browser session, the issuer's own included, is an OAuth grant of the
in-process provider; every bearer ends in `authorizationOf`) with four barnacles:
`authorizationForToken` constructs a whole `OAuthProvider` with a fake handler and fetches a
synthetic `/api` request because the provider exposes no verify-token call (the provider is
already pnpm-patched; add `verifyAccessToken(token)` to the patch, −20); `authenticate({type:"bearer"})`
without a token is a second name for `from-server-cookie` that nobody calls (−3);
`publishGlobalFact` is called five times in `session.ts` and spelled by hand a sixth time in
`consent.ts` without the `processors.enable` step and a seventh in `grants.ts` (export it, −42);
`passwordSignInOffered`/`emailSignInOffered` are one-line predicates with one caller each.

### 1.12 scripts/preview.ts is bigger than most of src (−110)

924 lines: a pure, tested half (naming, PR-body section, wrangler config) and an effects half, plus
five duplicates of `scripts/lib` (`run`/`runOk` vs `deploy-helpers.run`; `cf`+`account` vs
`resolveEnvContext`; `waitFor` vs `smokeResponse`; `deleteAppPreview` and `deletePreview` are the
same 25 lines; `parseArgs` called three times). 93 preview-only lines are parked in
`generate-wrangler-config.ts` and imported only by preview. After: `preview-config.ts` (~200, pure,
what the test imports) and `preview.ts` (~600). The PR-body section's two ops tables duplicate
README §Previews; make it the URL line, the apps table and a link.

The deployed-target e2e env is assembled by hand in four places (`deploy-os-next.yml`,
`os-next-crash-hunt.yml`, `os-next-e2e-soak.yml`, `preview.ts`): the `node -p "JSON.parse(process.env.APP_CONFIG)..."`
incantation plus `DEMO_BASE_URL`/`MCP_BASE_URL`/`PROJECT_INGRESS_ROUTING`. Derive them in
`e2e/support/global-setup.ts` from `APP_CONFIG` and the matching `osNextEnvs` entry (host suffix);
workflows become `doppler run -- pnpm e2e`. `crash-hunt.yml` and `deploy-dash.yml` still
`pnpm install` while #2778 moved the others to the baked image.

### 1.13 The naked context is explainable; two pieces are over-built (−34, one behaviour change)

The mechanism in three sentences: every `itx.…` call is rewritten by the context's own rule table,
longest match wins, `null` refuses, until it is rooted at `itx.builtins`; where no row claims the
call, its root gets the implicit row `itx.x ⇒ itx.builtins.x`, all 29 roots at a project root and
the 14 `CONTEXT_ROOTS` below; so a child reaches project resources only through the bare link its
creator's saga writes at birth. That is fine and right-sized. Over-built: (a) the reduce's "a
target restating the implicit row is deleted unless a bare-null wall stands" (26 lines + 11 test
rows): a redundant row resolves identically, the rule only keeps `list()` tidy, and its `wall`
exception makes row **order** matter at the owner root, the only order-sensitive thing in the
table. Drop it; the word "wall" leaves. Behaviour change on the owner root, Jonas's call. (b) The
DO's inherited-row shadow filter re-implements longest-prefix matching as string tests; use the
resolver's own `pickItxExpressionRewriteRule`. −8.

### 1.14 examples/voice-agent is a product, not an example (−3,813 from os-next, 0 net)

3,236 lines including tests and assets (1,397 added yesterday by #2746): the userspace code for the
Kit voice devices, its own font and licence, a PNG decoder and dither, a 187-line prompt, a fixture.
Nothing in `src` imports it; the unit lane runs its four test files. Its four operator scripts
(`voice-install/call/board.ts`, `inspect-context.ts`, 577 lines) are in `scripts/` but in neither
`tsconfig.scripts.json` nor knip's globs: untypechecked, unlinted. Move the lot to `apps/kit` (beside
the firmware that speaks this wire) or its own package with a tsconfig and knip entry;
`apps/os-next/examples` keeps `mini-app.ts`, which is what "examples" means. Inside it:
`README.md:79` and `voice-call.ts:12` tell the reader to `doppler secrets get APP_CONFIG_ADMIN_API_SECRET`
(gone since #2759); `worker.ts:14` claims a `processEvent` it does not have; `voice-delegate.ts`
spells the agent birth certificate by hand instead of `itx.agents.create(path)`.

### 1.15 `memory-budget-scenarios.ts` is a program in `src/` (0 LOC, one move)

Test-only (only `import type` from its test, which spawns it), typechecked under the prod tsconfig,
with top-level `process.argv` / `process.exit` / `await scenario(...)`: an accidental value import
from a prod file runs a scenario or exits the isolate. The 2026-09-09 report flagged "test rigs in
src"; nothing moved. Move to `scripts/` (the node lane that already exists) or gate the run on
`import.meta.url`.

### 1.16 Things read whole and judged fine (do not touch)

`rpc-stubs.ts` (both sides of one wire, banner-separated, its WORKAROUND fence carries a delete-day
checklist), `itx-expression-rewriting.ts` (no duplication with the SDK codec), `iterate-context.ts`,
`alarm-coordinator.ts`, `worker-loader.ts` (its long header is all why), `scheduled-appends.ts`,
`test-support.ts`, the SDK's `processor.ts` (1,187 lines, four cohesive sections, the bundler filter
wants one path), `rpc.ts`, `api.ts`, `mcp.ts` minus its banner, `identity.ts`, `issuer-session.ts`,
`secret/durable-object.ts`, `workspace/durable-object.ts`, `repo/durable-object.ts`, `git-wire.ts`
(hand-rolled on purpose; no small protocol-v2 client for Workers exists), `directory.ts` (the D1
control plane; not an entity; the org's name in D1 and on the log is #2755's design, say so once).
The secrets pure/host split (`secrets.ts`, `secret-at-rest.ts`, `secret-oauth.ts`) is earned by the
node-lane table test; what is not earned is three top-level files beside a `secret/` folder named
for the same thing. Move them in; do not merge them.

### 1.17 `useIterateContext` does four jobs and three of them are always on (≈ −200)

`packages/iterate/src/next/client/react.tsx:194–418`. Per mount it opens the stream subscription
and catch-up (the log), re-reads `processors.list()` on subscription events, re-reads
`rpcStubs.list()` on **every head advance**, and opens N `connectLiveState` subscriptions (`core`
plus every hosted facet) wired into React state by hand, which is a second implementation of
`useLiveState` 90 lines above it. Its two callers are the dash activity pages and the agents page.
Concretely wrong: the agents Chat tab pays for the Events tab (the hook runs for both tabs, the view
mounts for one); the census is a hot-loop RPC (each `agent/llm-response-chunks` batch moves `head`,
so one `rpcStubs.list()` per streamed chunk, to update a "N live stubs" span the chat tab never
shows, and the count includes the viewer's own lent subscription stubs, so a lone viewer reads
"3 live stubs"); the `agent` facet is subscribed twice on the agents page (the hook's every-facet
default plus the page's own `useLiveState(context, { key: "agent" })`); every batch rebuilds and
re-sorts the whole log and walks it twice more.

After (one hook named for the noun, per the 2026-09-21 steer):
`useIterateContext(itx, { consumes }) → { events, caughtUp, error, processors: { rows, loaded, error } }`
and `useLiveState` unchanged as the only live-state wiring. `presence.actors` becomes a pure fold
over `events` in the view (`whoActed`, ~12 lines); the `rpcStubs` census and its span go; per-row
live state goes back to a 28-line `FacetLiveState` component calling `useLiveState`, mounted only
inside the open sheet (which is exactly what #2766 had before #2774 traded it for +90 lines in the
hook and two `LiveStateValue` copies). `IterateContextEvent` and `IterateContextProcessorRow` are
field-for-field copies of `StreamEvent` and `SubscriptionListEntry` from the same package.

### 1.18 The "packages/ui stays free of the SDK" rule is why everything is spelled three times (≈ −160 more)

The rule is written in five files. Its cost: the event envelope spelled five times
(`ContextViewEvent` ≡ `IterateContextEvent` ≡ `StreamEvent` minus `path`, plus apps/os's and the
agents zod), the processor row three times (`hostedFacet?` six times repo-wide), the presence type
twice, two identical `LiveStateValue` components (dash, agents), two render-prop slots, and a
65-line `ContextActivity` that exists only to glue hook to view. `iterate` already depends on
`@iterate-com/ui`; the reverse would be a workspace cycle. So the context view can live in the
SDK's react entry and take `itx` directly (`<ContextView itx renderers inspectors state onStateChange />`),
calling the hook and, in its panel rows, `useLiveState`. That is the backlog's own steer ("the SDK
should mostly be React components and hooks"). The pure pieces (folds, filters, their tests) stay in ui.

Inside the view, parts with one consumer or none: `rendererFor`'s longest-`*`-prefix loop (no
registry key ends in `*`; only a test exercises it), `EventRenderer`, `EMPTY_FILTER`,
`factByPayload` (`ContextView` always passes `factOf`), `presence-strip.tsx` as a file. ≈ −70. Two
clocks on one page: the agents Chat tab's round headers use their own 12-hour `formatClockTime`
while the Events tab is h23.

### 1.19 The four apps: what should stay spelled and the two folds the rule allows

`router.tsx`, `worker.ts`, `__root.tsx`, `_auth.tsx`, `index.tsx`, `projects.index.tsx`,
`styles.css` are 7–49 lines each and near-identical across dash/agents/notes/voice (notes ≡ voice
byte-identical): **stay**, per the no-`appWorker` steer; #2782 already folded the components. Two
notes: agents alone lacks the signed-in `/` redirect, and the same eight-line comment on
`defaultPendingComponent` is pasted into four routers (it belongs once, above
`DefaultPendingComponent` in `route-defaults.tsx`).

Folds that are a component or a hook: (a) the breadcrumb block `header={<Breadcrumb>App › slug</Breadcrumb>}`
(13 lines) is identical in agents/notes/voice; `AppShell` already knows the app and the active
project, so render it when `header` is omitted (+6, −39). (b) "hold a capnweb stub in state,
dispose on unmount" is spelled four times (15–37 lines each, ≈100 lines, the same three-line
"callable proxy" comment in three of them) and the four disagree about disposing `api.user`; one
`useIterateContextStub(() => api.projects.get(id).cd(path), deps)` in the SDK (~30 lines). (c) The
project lookup by slug-or-id is spelled six times; the one-line `find` should stay spelled, but the
**fetch** (`projects.list()` in the dash `_auth` loader, again in `$slug/route.tsx`, again in
`home.tsx`, once per page in the other three apps) could ride `authenticate()`, which already does
`api.info()`; caveat that the connect is memoized so a create must refresh it. Medium risk; if not
done, leave all six.

`apps/dash/src/apps.ts` hard-codes three prd URLs as sidebar links in every environment: a preview
dash links to prd agents, a self-hosted dash links to iterate's. Derive from `envs.ts` like
`ITERATE_DENY_ZONES` (#2764) or drop the group. `apps/voice/src/call.ts` hand-declares a `CallItx`
slice and casts to reach it; `api.projects.get()` already returns `IterateContextApi` (−12).

### 1.20 apps/agents (3,981 lines): what can go now that the Events tab exists

`ScriptTraceContent` (80 lines) + `scriptTrace` (48) + the `scriptExecution` search key are covered
by the Events inspectors (`run-requested` shows the code, `run-settled` the result, the developer
`context-added` what the agent saw); the feed's "Execution trace" buttons can link to
`?view=events&event=<offset>`. −130, medium confidence. The LLM trace has no equivalent and stays.
`toAgentEvent` deep-copies (`JSON.parse(JSON.stringify(raw))`) and re-validates with zod what the
hook already deep-copied and shape-checked, per event, per batch (−12). ≈430 lines
(`streaming-text.tsx`, `full-text-snapshot.tsx`, `use-ticking-now-ms.ts`, `composer-attachments.tsx`,
`use-composer-attachments.ts`) are near-verbatim forks of apps/os files with no apps/os-specific
imports, exactly the component/hook fold the rule allows: −430 in agents and −430 in apps/os for
+430 in ui (the backlog parked it as "touches apps/os"). `web-agent.ts` is one function with one
caller. The loader re-lists projects and agents on every `?agent=` change though neither depends on it.

### 1.21 SDK internals riding the SDK

`packages/iterate/src/next/principal.ts`: `Caller`, `stampCaller`, `signClaims`, `verifyClaims`,
`verifyAdminSecret` and the three `ITX_*_HEADER`s are platform internals imported by os-next only;
`Principal` and `cookieValueOf` are the SDK-shaped part. Already parked in the backlog; agreed,
−120 from the SDK. `app-server.ts` `scopeLabels` is a second copy of `OAuthScopeDescriptions` in
shorter words (one map, a `short` field). The SDK's unit test for `expression.ts` lives in
`apps/os-next/src/context/`, and the tests for the SDK's `stream/processor.ts` live in
`apps/os-next/src/stream/` (1,458 + 609 lines + the rig), not next to the module they test.

## 2. Delete (consolidated)

Platform, ordered by value. Each verified by grep for callers.

- `iterate-context-durable-object.ts:363–375` the `migration:explicit-ingress:remove-default-subscription`
  shim, added yesterday by #2746, runs a `JSON.stringify` compare on every DO construction forever.
  The repo's own directive is no compat shims. One prd sweep, then delete. −14.
- The core live-state (1.4). −45.
- `worker.ts:404–419` the `auth.require` gate (1.11). −18. `oauth.ts:166–170` `resourceMetadata` in
  `providerOptions`: `api.ts` answers `/.well-known/oauth-protected-resource*` before the provider
  is constructed. −5.
- `repo/durable-object.ts:172–195` `readModules`: superseded by `modules()` (#2790); only e2e calls
  it. Check prd userspace `worker.ts` files first (garple used it before #2790). −24 plus the library type line.
- `stream.ts:326–338` the reserved-name check at the stream door half-duplicates `parseSubscriptionName`;
  fold the `core` refusal in. −11. The 8 MiB ceiling measured twice by event kind (ephemeral at the
  door, durable at insert): measure once. −8. `StreamDeps.recentEphemeralsBudgetChars` is passed only
  by one test. −5. `LiveState.deltasSettled()` is a test seam the tests do not need. −5.
  `ProcessorContract.description` is required by every contract and read by nothing. −12 across nine contracts.
- `StreamPage` and `WaitForEventFilter` are byte-identical in `stream.ts` and the SDK's `api.ts`. Import. −14.
- `session.ts` aliases `ProjectRef = string`, `SessionPrincipal = Principal`. −4. The token-less `bearer` form. −3.
- `agent/contract.ts:133–137` an orphan docstring for a `plainResponse` knob removed by #2758. −5.
- `agent/processor.ts` indirection constants used once (`AI_GATEWAY_ID`, wedged between imports;
  `CHUNK_WINDOW_MS`; `CHUNK_WINDOW_MAX_CHARS`). −8. Same in the DO (`PIN_RELEASE_AFTER_IDLE_MS`,
  `FACET_CALL_WATCHDOG_MS`), `rpc-stubs.ts` (`RPC_STUB_PAGE_TIMEOUT_MS`), `repos.ts` (`PROBE_TOKEN_TTL_SECONDS`):
  each used once, each exists to carry a docstring; inline with the comment, or skip if it is churn.
- `wrangler.base.jsonc:34–37` a `routes` entry no generated config keeps, whose comment names a
  `projectHostOf` that no longer exists; line 62 names `APP_CONFIG_ARTIFACTS_*` vars that exist nowhere. −8.
- `package.json` `db:schema:remote`: the worker applies `control-plane.sql` at boot since #2759. −1.
- `context/ingress.ts` (19 lines, no header, one caller): fold into `core-processor.ts`. −9.
- Exports with no importer outside their file (un-export; knip is "clean" only because these are
  unchecked): `admitLoadedCodeExpression`, `RpcStubFetchTransport`, `R2ObjectRecord`,
  `DEFAULT_FILE_URL_TTL_SECONDS`, twelve types in `library.ts`, `StoredEventRow`, `OpenScriptRun`,
  `HostingFacetSpec`, `isRefreshKind`, `MaterialBinding`, `TreeEntry`, `encodeTree`, five in
  `workspace/durable-object.ts`, `retryBackoffMs`, `contextWindowTokens`, `alarm-coordinator.snapshot().passInProgress`.
- `Grants extends RpcTarget` and eight other subclasses (`Consent`, `McpConnection`, `OpenApiConnection`,
  `ScopedArtifactRepo`, `OrganizationCollection`, `ProjectCollection`, `RewriteRuleHandle`,
  `SubscriptionHandle`) break the HARD "ends in RpcTarget" rule. Rename; 0 LOC.

SDK, UI and apps (every importer count checked across apps/os too):

- `packages/ui/src/components/ai-elements/`: only `conversation.tsx` and `message.tsx` are imported
  from outside; `prompt-input.tsx` (1,406 lines) is imported by nothing, and with it die its six
  private copies (`command`, `dropdown-menu`, `hover-card`, `input-group`, `select`, and `nanoid`)
  and four files nobody imports at all (`dialog`, `input`, `separator`, `textarea`). ≈ −2,500. Most
  of #2784's 17 remaining react-doctor errors are in these files.
- `terminal.tsx` (402) + `terminal-xterm-overrides.css` + `mobile-keyboard-toolbar.tsx` (603, only
  terminal imports it) + the seven `@xterm/*` deps and `partysocket`. −1,013. Zero importers, confirmed.
- Zero-importer primitives, the ones carrying a dependency first: `carousel` (+ `embla-carousel-react`),
  `chart` (+ `recharts`), `calendar` (+ `react-day-picker`), `sidebar-theme-switcher`, then
  `combobox`, `menubar`, `navigation-menu`, `pagination`, `toggle-group` + `toggle`, `button-group`,
  `accordion`, `progress`, `slider`, `hover-card`, `radio-group`, `kbd`, `aspect-ratio`, `direction`.
  −2,186. The four Jonas named are confirmed dead; keeping unused shadcn primitives is a taste
  call, the dependency-carrying ones are the clear wins. `next-themes` stays.
- `agent-inspectors.tsx` `ScriptTraceContent` + `agent-events.ts` `scriptTrace` + the
  `scriptExecution` key (1.20). −130. `shortEventType` exported, no caller. `web-agent.ts` inlined.
- context-view: `rendererFor`'s prefix loop (−14, −15 test), `EventRenderer`, `EMPTY_FILTER`,
  `factByPayload`, `presence-strip.tsx` (1.18).
- SDK: the `LiveStateSink` re-export and the `ConfigWorkerItx` alias in `sdk/index.ts`; the dash's
  `Org`/`Project` re-declarations of `OrgRecord`/`ProjectRecord`; `NotFoundFallbackProps`'s
  `[key: string]: unknown` (the four call sites pass `action` or nothing).
- `tasks/os-next-apps-sdk-cleanup-backlog.md`: a 2026-09-18 plan whose done-list is history and
  whose parked list is partly done (#2782) or superseded by this file. −58.

## 3. Comments: the sweep and the specific lies

The pattern, not just the instances. 24% of yesterday's added source lines are comments. 47 of 68
files open with `// <file> — THE X: ...`, and banner blocks run to 34 lines
(`itx-expression-rewriting.ts`), 33 (`agent/contract.ts`), 28 (`subscription-delivery.ts`),
25 (`core-processor.ts`). 356 comment lines shout two or more capitalised words; in `rpc-stubs.ts`
it is one line in ten, in `worker-loader.ts` 46% of non-blank lines are comment. The same rule is
often stated three or four times in one file (the zero-write ephemeral contract is at
`stream.ts` 6–18, 119–125, 454–457 and 498–499). Five files carry a one-line "table of contents"
after the header that has drifted (`library.ts` says "Five concepts:" and lists nine; `stream.ts:4`
and `core-processor.ts:25` are stray single entries). Lint-disable justifications are pasted five
times inside one method twice (`#subscriptionList`, `OpenApiConnection.call`); one block-level
disable each.

Proposed convention, applied in one sweep per area: a header of at most eight lines that says what
the file is for and the one invariant a reader must know; caps only for a defined term, once per
section; no PR history ("no longer", "was", "as before", "the v4 review's", dates); no toc lines;
each rule stated in one home. Reviewers should refuse a PR whose comment share of added lines is
over ~15%.

Comments that are **false** today (fix these regardless of the sweep):

- `core-processor.ts:258–260` and SDK `processor.ts:987–990`: "no zod on the edge/DO script" while
  zod is imported in 23 prod files including that one.
- `processor.ts:674`: "THE one deep-equal lives in patch.ts": no such file; it is `lib.ts`.
- 22 (my grep: 43) citations of "rule N" across eight prod files after #2779 deleted the numbered
  list they cite; the rewriting header now says "THE RULES live on the code they govern". Restore a
  compact numbered list (~25 lines, it was the area's best explanation) or drop the numbers.
- "M1", an invented milestone label used 36 times across 12 files, defined once in a docstring.
  Say "the source-less hosting row" at the eight prod sites.
- `agent/contract.ts:30–33`: "dropped from apps/os on purpose: streaming chunks, interrupts,
  compaction, token accounting": streaming chunks, interrupts and token accounting are all in this contract.
- `agent/processor.ts:338–345`: describes a check-then-append that #2787 removed.
- `account/contract.ts:16–20`: a payload-reuse claim that is half true and a type-gate "once
  enforced" that is not built.
- `iterate-context-durable-object.ts:407–409`: "Two callers" of the append boundary; there are five.
  `:211–215`, `built-ins.ts:468–473`, `git-wire.ts:138–139`: docstrings attached to nothing.
  `:1434–1443` two docstrings on `invoke`; `iterate-context.ts:98` the class docstring separated
  from its class by a constant #2764 inserted.
- `library.ts:41–70`: the 30-line litmus essay whose claim is false for five roots, and whose stated
  import rule disagrees with the one `library.test.ts` enforces (the test wins). `:752, 924` "index.ts".
- `subscription-delivery.ts:1` "THE ONE DELIVERY LOOP" over two lanes and two loops; `:191–194`
  the Set justified by a `deadlines()` read that does not happen; `:743–752` ten lines grown by
  #2757 narrating the bug it fixed.
- `worker.ts:1–2` "the console, MCP and project apps share OAuth grants" (no console); `:266`
  contradicts `:324–330`; `:421–422` false pointer at `control-plane.ts`; `:402` the `/api*` 404 is
  load-bearing and has no comment.
- `envs.ts:624`, `consent.ts:49`, `built-ins.ts:109`: paths ingress is `/projects/<project>/<app>`
  since #2759, not `/<project>/<app>`.
- `wrangler.test.jsonc:9–10, 57–58`: says the e2e lane applies `control-plane.sql` in global-setup; the worker does at boot.
- `wrangler.base.jsonc:88–89`: a commit message about the `SECRET` binding, in config.
- SDK `principal.ts:29` names `platform-origin.ts` (folded away by #2764); SDK `expression.ts:1,4,274`
  calls itself `context/expression.ts` and points at a rewriting module in another package; its unit
  test lives in `apps/os-next/src/context/`.
- `erase-data.ts:15–21`: "three KV namespaces… secrets"; the code erases two (#2770).
- `secrets.ts:1–6, 174`: "only erasable TypeScript syntax, so a type-stripping loader can take it": no loader strips this file.
- `git-wire.ts:40, 143–148, 690–696`: names `repos.test.ts` and "the three verbs `repos.ts` calls"
  (it is `git-wire.test.ts` and `durable-object.ts`).
- `repo/durable-object.ts:1`: an import above the file header (since #2746). `agent/processor.ts:5–7` a broken wrap.
- `core-processor.ts:334–336` a changelog inside a version constant; `agent/contract.ts:83–85`
  lists bumps 2 and 3 of a contract at version 5 (`project/contract.ts` lists all of its bumps, and
  that one is load-bearing: keep, and match).

SDK, UI and apps:

- The SDK's `stream/processor.ts` shouts 39 capitalised phrases (`THE CONCURRENCY CONTRACT`,
  `ONE SERIAL CHAIN`, `THE GUARDED REDUCE`, `MUTATION AND NOTIFICATION ARE INSEPARABLE`, …);
  `sdk/index.ts`, `expression.ts`, `react.tsx:181–193` (a 13-line docstring narrating the whole
  hook in caps), `app-server.ts:1`, `lib.ts` milder. Same sweep.
- Files moved into the SDK still point at their old home: `expression.ts:1,4,274,304` (a
  `context/expression.ts`, a rewriting module in another package, a history doc that does not
  exist), `processor.ts:179,674` (`test-support.ts`, `patch.ts`), `react.tsx:2–3,8–10` ("the hosted
  /demo and the control-plane console", neither exists), `live-state.ts:10,22` (`client/demo.tsx`),
  `lib.ts:266,286` ("the console's POST doors in control-plane.ts"). `lib.ts:1–6` says "four
  concepts" and holds seven; `:8–17, 61–66` narrate provenance from cloudflare-os and a Reporter
  Worker that does not exist.
- The same eight-line `defaultPendingComponent` comment in four `router.tsx` files (−24; once in
  `route-defaults.tsx`). Two consecutive docstrings on `useAgentContext`, the first describing the
  pre-#2766 return shape; the page header and `agent-inspectors.tsx:3–5` still list the raw-event
  trace #2766 deleted. `// explained: …` comments in `core-renderers.tsx:9` and
  `agent-event-renderers.tsx:14` that say they have explained. The two `LiveStateValue` headers
  each end "the other app carries the same few lines": a comment documenting duplication instead of
  removing it. `$slug/route.tsx:15–16` "(prd, #2783)" cites the wrong PR.

## 4. Docs: keep one, delete the rest, fix the index

`apps/os-next/docs` is 1.1 MB. Three living documents describe the same module family at 1,066 /
1,794 / 2,286 lines and each drifted yesterday (36 doc-commits in one day):

- `docs/itx-surface-as-built.md` (280 KB): not generated (no generator exists), hand-maintained,
  wrong in twelve places yesterday's PRs did not happen to touch (package path `packages/v3/project-worker`,
  `IterateContext`/`ProjectIdOrSlug` names that do not exist, `projectHostOf`, `APP_CONFIG_SECRETS_KEY`,
  the pre-#2704 TanStack console, 15 nonexistent files in its §11 table, `rpc-stub-relay.ts`); its
  roots table lists twelve of "the fourteen" while LAYERS.md, the tutorial and the walkthrough all
  send readers there for the list; 158 KB of it is prettier column padding. **Delete.** Repoint
  README "start here" at the tutorial and the three "fourteen roots" pointers at
  `src/context/itx-expression-rewriting.ts:114`.
- `docs/clean-room-api-walkthrough.md` (121 KB): pinned to a dead branch and package path, names
  nine missing files, still has `git: GitScope` (removed #2668), `/demo`, `build-sdk.mjs`,
  `definitions.sql`; every true sentence is in the tutorial or a docstring. **Delete.**
- `docs/tutorial-the-iterate-context-layer-by-layer.md` (133 KB): **keep**, one fix pass: ch7
  "Explicit config-worker targets" contradicts #2777/#2790 (a commit to `/repos/config` is the
  publication); ch10 describes a TanStack console under `src/routes/**`, a sessions page,
  `stampPrincipal` and two Playwright specs that do not exist; "there is no client SDK" (there is);
  ~12 `src/…` paths that moved to `packages/iterate/src/next/…`; `IterateContext` →
  `IterateContextRpcTarget`/`IterateContextApi`; two "PROPOSED, not built" design paragraphs inside a living tutorial. ≈ −80/+40.

History that git keeps (≈ 4,400 lines + 20 research files, all pre-#2747/#2759, matching removed
names): `cleanup-log.md` (616 lines; its one live entry, the library split, is 1.6 above),
`control-plane-context-plan.md` (its line counts are 2026-09-12's; resolved by the design doc, which
itself pins stale line numbers), `plan-auth-one-lane-2026-09-09.md`, `report-api-surface-structure-complexity-2026-09-09.md`
(this audit supersedes it), `unified-auth-{build,browser-review,grant-review,interface-review}.md`,
`docs/research/*` (the unified-oauth review rounds), `CONTEXT.md` ("vocabulary for the proposed
control-plane model", referenced only by the plan), the plan half of `docs/project-creation.md`
(names events that do not exist; its table contradicts the saga), `tasks/2026-09-21-os-next-self-hosting.md`
(everything in it shipped as #2759/#2762). `docs/scheduled-appends.md` was checked number by number: correct.

Living docs with wrong sentences:

- `README.md`: "authenticate takes one of two kinds" (three); `pnpm test` "every lane: unit,
  workers, e2e, bench" (unit and workers only); a broken `../../../docs/archived-experiments.md`
  link; the sign-in and consent paragraphs each said twice; a disclaimer that docs/ holds history
  (delete the history instead).
- `LAYERS.md`: `rpc-stub-directory.ts` (no such file), "idle quiesce" (renamed by #2756),
  `rewriteRuleConfiguredEvent`/`subscriptionConfiguredEvent` (neither exists; the real thing is
  `normalizeRewriteRuleConfigured`), the core-slice list missing `ingressTarget`, `schedules`,
  `scriptRuns`, `sdk/index.ts` and `stream/processor.ts` pointed at the app instead of the SDK, a
  table cell naming the same file twice, "Slack-bridge RpcTargets" (no Slack bridge).
- `SELF-HOSTING.md:77–82` custom domain cannot work as written: the generated config sets
  `APP_CONFIG_URLS__INGRESS_ROUTING={"type":"paths"}` as a var and vars override the blob, and the
  next `pnpm build` regenerates the config the reader hand-edited. Drop the section or make the generator take the domain.
- `docs/archived-experiments.md:14` link text is the pre-09-12 package name. `knip.ts:204–211`
  lists `scripts/vite-plugin-processor-sdk.ts` (does not exist) and excludes `scripts/**` and
  `examples/**` from the os-next project, so knip never sees the voice scripts or `mini-app.ts`.
- `rules/terminology/no-metaphorical-lane-door-seam.md` bans `lane`, `door`, `seam` at severity
  error; os-next `src` has 154 non-test lines in 19 files using them, test files are named for them
  (`session-doors.test.ts`, `do-doors.test.ts`), README and LAYERS say "THE ONE FRONT DOOR". Either
  the rule exempts `apps/os-next` or the metaphor goes; a rule nobody applies is worse than none.

App and SDK docs: `apps/agents/README.md` describes `/agents?project=<id>&agent=<path>` (the
route is `/projects/<slug>?agent=`), `script-run-requested` cards (os-next's are
`context/run-requested`), `itx.agents.get(path).create({ systemPrompt })` (the code is
`itx.agents.create(path)`), and no Events tab; rewrite ten lines or delete it, the page header
says it better. `apps/dash/README.md` omits the `organizations:write` scope it asks for.
`docs/frontend-development.md` documents apps/os's hooks only; the four apps' conventions
(`_auth` + `createIterateClient`, `AppShell`, `ContextView`, `route-defaults`) have no home, which
is fine until the API settles.

Two more docs README holds up as current and which are not: `design-onion-subscriptions-processors.md`
(71 KB, README's "design of record") is a synthesis of six candidate designs against a September
HEAD whose §7–10 are what-you-lose / where-candidates-disagreed / risks; it names
`subscriptionConfiguredEvent` ×5, `rewriteRuleConfiguredEvent`, `rpc-stub-directory`, `secrets/changed`
(the events are `secret/set`/`secret/deleted` since #2770), `itx.rpcStubs.get` as a target (since
#2758 targets are `itx.builtins.rpcStubs.get`) and "quiesce"; LAYERS.md says the same five layers
in 20 KB. `unified-oauth-architecture.md` (README's "the current OAuth design") describes an issuer
router with a form search codec and Start loaders (the issuer is two plain files since #2747) and a
notes dashboard on `notes.iterate2.com` importing "the same component and loader" (notes is on
workers.dev). Delete both; README's Hostnames table and the `oauth.ts` header carry the living half.
`scheduled-appends.md:95–147` restates the alarm coordinator and the ring (their file headers say it);
keep the first 94 lines. `docs/history/README.md` points at a backup branch and the as-built doc.
After all of it, docs/ outside the tutorial is ≈54 KB and README's "Read next" drops from eleven
entries to four.

### 4.1 Tests: the harness leaking into the layout, and spellings

- **`vitest.config.ts:46–68` `LONG_POLES` + `LongPolesFirst`** is a hand-maintained list of four
  file names standing in for vitest's duration cache, which CI does not persist; three one-row e2e
  files (`agents-streamed`, `isolate-ceilings-slow-client`, `scheduled-appends-dormant`, 43/44/72
  lines) exist only to be on that list, and their headers say so. Persist the cache dir across CI
  runs (the depot workflow already restores `node_modules`, and `cache.dir` lives under it) and
  delete the sequencer, then fold the three files into their parents (≈ −80). If the cache route
  is refused, keep the sequencer, still fold the files and list the parents. One CI run proves it.
- **`until` is spelled twice with different failure semantics** (`e2e/support/client.ts:237`
  absorbs a throw and reports the last error at 20 s; `__workers-tests__/support.ts:124` lets a
  throw escape at 10 s): a row moved between lanes changes behaviour silently. The workers lane
  already loads `client.ts` (through `principal.ts`); import `until` and `sleep` from it. `sleep`
  is four named spellings plus 33 inline `new Promise(setTimeout)`; `settle` names two unrelated
  things (`isolate-ceilings.ts` a promise outcome, `stream/test-support.ts` a sleep).
- **`specs/` spells its support twelve times in one directory**: `loginPassword` three ways with
  three different localhost fallbacks, `adminSecret` two, `stamp()` three byte-identical copies,
  `claudeClient` two, `signIn` two (one with a dead `_next` parameter, the other's docstring
  claiming to be "the way auth.spec.ts does" and not being). One `specs/support.ts`. −35.
- **Rows that assert the same behaviour** (keep the first): the retry ladder on the DO alarm
  (`uncontrolled-degradation` E1, deterministic; `cursor-delivery:230`, real wire;
  `alarm-and-pins:578` is E1 with less precision); disable → re-enable rebuilds from the log
  (`alarm-and-pins:182`, `push-delivery-no-dropped-warns:70`, `processor-facets:354`); the bare
  `/api` socket authenticating in-band (`control-plane.test:152`, `session.e2e:74`, `oauth.test:327`);
  the project host stripping forged headers (`control-plane.test:294` and the e2e pair; the e2e pair
  runs against prd). `__workers-tests__/oauth.test.ts:408–641` is one 233-line row that would read
  as three. The 600+ line files otherwise read top to bottom; no split earns its keep.
- Support files judged fine: `petshop.ts` (the fake OAuth provider, named), `project-host.ts`'s
  four gates, `log-harness.ts` vs `global-setup.ts` (exactly twice), `agents.ts`, `isolate-ceilings.ts`,
  `fake-artifacts.ts` + `fake-git-server.ts` (one consumer chain). `WebSocketRoundTrip` has no importer.
  Two `test.skip("…", () => {})` with empty bodies in `control-plane-contexts.test.ts` are todos spelled as skips.
- Test comments: three `alarm-and-pins` row titles still say "QUIESCE" after #2756; a 36-line
  banner in `isolate-ceilings-deployed` restates every row title below it; a rejected-alternatives
  log in `hibernation-at-scale`; 19 lines of dated measurements on two config keys in
  `vitest.config.ts`; seven "used to / no longer" narrations in e2e rows; a pointer to a session
  scratchpad in `uncontrolled-degradation.test.ts:20`.


## Decisions taken (2026-09-22, Jonas)

- **PR 1 is pure deletion, nothing else**: every doc this plan marks for deletion (as-built, the
  walkthrough, cleanup-log, both control-plane docs, design-onion, the 09-09 report and plan, the
  unified-auth/oauth files, `docs/research/`, `docs/history/`, `CONTEXT.md`, the plan tails of
  `project-creation.md` and `scheduled-appends.md`, the shipped self-hosting task, the superseded
  apps/SDK backlog), the dead `packages/ui` components with their dependencies (the small unused
  shadcn primitives included: decision (k) is "delete"), and anything else in the delete list that is
  dead by grep rather than by analysis (orphan docstrings, the dead knip entry, the dead
  `db:schema:remote` script, the empty skips, the zero-importer exports). Deletions that need a
  behaviour argument (the `auth.require` gate, `resourceMetadata`, the migration shim, the core
  live-state, `readModules`) wait for their own PRs.
- **The os-next scripts get type-checked.** `scripts/voice-*.ts` and `inspect-context.ts` join
  `tsconfig.scripts.json` and knip's globs regardless of where voice-agent ends up living (decision
  (e) stays open). Own PR right after PR 1, since it may need type fixes.


## What the implementers found the plan got wrong (2026-09-22, wave 2)

- **The token-less `authenticate({ type: "bearer" })` is a wire contract, not dead code.** The Kit
  firmware (`apps/kit/firmware/components/core/src/itx_mount.c`) sends `{ type: "bearer" }` alone after
  its token rode the upgrade; the audit grepped TypeScript only. Kept, with the reason on the schema
  (#2817, caught by Bugbot). Any "no caller" claim about the `/api` wire must grep the firmware.
- `EntityCreationAndDeletionState` cannot live in `project/contract.ts` (it imports the three entity
  contracts for `processorDeps`; the reverse import is an ESM cycle that throws at evaluation). It lives
  in `src/project/entity-state.ts` (#2814). `SecretCatalogEntry` is the SDK's type in `iterate/next/api`,
  so `built-ins.ts` pins `SecretCatalog` against it rather than deriving it.
- `#cursorDeliveryRunning` and `#cursorDeliveryLoops` were not fully redundant: `#drainCursor` can finish
  on its first synchronous turn and the Map entry was registered after the call. One lock, but the entry
  is written before the drain's first turn (#2819).
- `run`/`runOk` in `preview.ts` cannot fold into `deploy-helpers.run`: the sync `run` cannot serve the
  concurrent spawns; one capturing `run` stays (#2816). The previews list is paged at 10 by default —
  the sweep had been silently missing the rest. The close-triggered preview delete then crashed on a 202
  with an empty body and on a namespace already gone (#2821).
- `resourceMetadata` was only half dead: `authorization_servers` goes, `scopes_supported` is read (#2817).
  Two tests did assert the `auth.require` redirect (`fetch-door.e2e` "the old RPC routes are GONE",
  `issuer-bootstrap` `/authorize.json`); they now expect 404.
- Fourteen test literals pinned the offset the core live-state delta used to take; deleting it moved them (#2819).
- "Preview OS-Next / e2e" shows **skipping** on every PR by design (dispatch-only); the deployed suite
  rides the `deploy` job. The checks list alone looks like the proof did not run.
- `CapnwebConnection extends InvokeHandle` (an RpcTarget): the SDK names that family `*Handle`, so it
  was left un-suffixed pending a word (#2813). Six moved comment lines in `library/openapi.ts` and
  `library/connection.ts` still carry `lane`/`door` — decision (g).
- Before row 9's `.strict()`: the Doppler `project-worker/preview` `APP_CONFIG` blob carries a stale
  `login.cloudflare` key (the worker warns at every boot); remove it from Doppler first.
- `deploy-dash.yml` still `pnpm install`s along with its three twins (agents/notes/voice); moving the
  four to the baked dependencies is one PR, not this row's.

## 5. PR sequence

Small PRs, LOC in the body, platform and app split, each proven against the deployed worker where
it touches behaviour. Order is by value over risk; items marked DECIDE need Jonas's word first.

| # | PR | est. LOC | risk | needs |
|---|---|---|---|---|
| 1 | Docs: delete as-built, walkthrough, cleanup-log, the plans/reviews/research, CONTEXT.md, the stale task; fix README/LAYERS/tutorial sentences; repoint the roots pointers | −8,000 | none | MERGED #2808 |
| 2 | Entities: one `EntityCollectionRpcTarget(slug)`; one `SecretCatalog`; shared lifecycle schema; ingress-target literal once | −350 | low | MERGED #2814 (collection, secret catalog, lifecycle schema, ingress literal; reduce + parent link still DECIDE) |
| 3 | Stream: cursor rows read the ring, drop the pushed-batch memo; delete the core live-state; the lock Set; `StreamPage`/`WaitForEventFilter` imported | −150 | med | PARTLY MERGED in #2819 (core live-state, lock, StreamPage import, reserved-name, ceiling); the ring change still DECIDE |
| 4 | Control plane: `platformAddressesOf`, `IngressRouting` once, `#platformOriginNow` gone, second `registrableDomainOf` gone; delete the `auth.require` gate and `resourceMetadata`; `publishGlobalFact` exported for consent and grants | −90 | low | MERGED #2815 (except the token-less bearer form — see corrections) |
| 5 | Context core: `context/facet-host.ts`; `describeRewriteRules` into rewriting.ts; the DO's five/three duplications; `admitRow` at the append boundary via `normalizeControlEvent(event, ownPath)` | +40 / −30 | med (workers lane pins the facet lifecycle) | MERGED #2820 |
| 6 | library.ts split into `library/{capnweb,mcp,openapi,connection}.ts`; honest header; `LibraryItx` trimmed | −50 | low | MERGED #2813 |
| 7 | Core fold: one validation boundary; `builtInsGetStep`; the marker destructure; `ingress.ts` folded in; the reserved-name and double-ceiling checks | −60 | low | MERGED #2819 |
| 8 | worker.ts: secret-OAuth callback out, brand registration to the entrypoint; `control-plane.ts` → `issuer-pages.ts` + `env.ts`; `login-code.ts` renamed | 0 | low | MERGED #2817 (also deletes the auth.require gate and resourceMetadata's dead half; signed-out `GET /nonexistent` is a 404, not a login redirect) |
| 9 | app-config: discriminated union + `.strict()`; the shared parser's union early-return; local-dev defaults once | −50 | med | check the prd blob for unknown keys first |
| 10 | agent: `agent/model-call.ts`; constants inlined; orphan docstring gone | 0 (−42 if the `@cf/` route goes) | low | DECIDE: `@cf/` route |
| 11 | preview.ts split + scripts/lib folds; the generator's preview lines rescued; e2e env derived in global-setup; workflows to `doppler run -- pnpm e2e` | −130 | low | MERGED #2816 + #2821 |
| 12 | The migration shim: one prd sweep, then delete | −14 | med | run the sweep |
| 13 | voice-agent example + its four scripts moved out of os-next with a tsconfig and knip entry | −3,813 from os-next | low | DECIDE: `apps/kit` or its own package |
| 14 | `memory-budget-scenarios.ts` to `scripts/`; `readModules` deleted after the prd check; un-exports; RpcTarget renames | −40 | low | PARTLY: the scenarios move landed in #2819, the RpcTarget renames in #2813/#2815/#2817/#2820; readModules + the rest open |
| 15 | Naked context: drop the restate normalization and the string shadow filter | −34 | med | DECIDE: behaviour change at the owner root |
| 16 | Comment sweep, one PR per area, under the convention in §3; the false comments fixed first | −600 to −900 | none | agree the convention |
| 17 | The "rule N" list restored or renumbered; "M1" spelled out | +25 | none | DECIDE: restore or drop |
| 18 | ui: delete the dead two-thirds of `ai-elements/`, terminal + toolbar + xterm/partysocket, the dependency-carrying primitives (carousel, chart, calendar), sidebar-theme-switcher | −4,500 to −5,700 | low | DECIDE: the small unused shadcn primitives too |
| 19 | SDK hook: `useIterateContext` → `{ events, caughtUp, error, processors }`; census gone; `FacetLiveState` back inside the sheet; the two SDK type copies replaced by `StreamEvent`/`SubscriptionListEntry` | −200 | low-med | DECIDE: the hook shape (Jonas wants to revisit these APIs) |
| 20 | Context view into the SDK's react entry, taking `itx`; ui keeps folds/filters; both `LiveStateValue` and `ContextActivity` go; the one-consumer parts of the view deleted | −230 | med | DECIDE: SDK home vs a third package |
| 21 | Apps: `AppShell` renders the breadcrumb when `header` is omitted; `useIterateContextStub`; `apps.ts` URLs from envs; voice `CallItx` gone; agents `ScriptTraceContent` + `scriptTrace` gone; `toAgentEvent` takes the hook's event; the four-router comment once; the two READMEs fixed | −300 | low | |
| 22 | agents/apps-os forks (`streaming-text`, `full-text-snapshot`, `use-ticking-now-ms`, composer attachments) into `packages/ui` with their tests | −430 net | med (touches apps/os) | |
| 23 | SDK: `principal.ts` platform internals back to os-next; `scopeLabels` folded into `OAuthScopeDescriptions`; the SDK's tests moved next to the modules they test | −120 | low | |
| 24 | Tests: `specs/support.ts`; the workers lane imports `until`/`sleep` from `client.ts`; the duplicate rows dropped; the "QUIESCE" titles and the test-comment items; the empty skips | −80 | low | |
| 25 | Tests: persist vitest's cache in CI, delete `LongPolesFirst`, fold the three one-row files | −80 | low | one CI run to prove the cache restore |

Decisions for Jonas, collected: (a) share the lifecycle reduce, or only the schema; (b) parent link
in the collection door, or three saga copies; (c) the `@cf/` model route; (d) drop the restate
normalization (row order stops mattering at the owner root); (e) where voice-agent lives; (f)
`.strict()` boot refusal on unknown config keys; (g) the `lane/door/seam` rule versus os-next's
vocabulary; (h) the comment convention and the ~15% ceiling; (i) restore the numbered rules or
drop the numbers; (j) the `useIterateContext` return shape and whether the context view moves
into the SDK; (k) the small unused shadcn primitives; (l) the vitest cache instead of the sequencer.

Sum of the estimates above, if every row lands: ≈ −8,600 lines of docs, ≈ −5,700 lines of dead
ui, ≈ −2,300 lines of platform and app code (net of the moves), ≈ −3,800 lines moved out of
os-next, plus the comment sweep. `apps/os-next/src` would go from 33k to roughly 30k lines and
read as one convention per concept instead of three.
