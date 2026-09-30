---
status: on-hold
size: large
---

# Codebase simplification sweep: heavy machinery with simpler shapes

Status: on hold (Jonas, 2026-09-30). The no-brainers landed in #3460. The other 51 cuts, about −7,000
lines, wait on the 20 calls below. The per-candidate research is in
`codebase-simplification-sweep/<area>.md`, one file per area.

## Why

Jonas, 2026-09-29: "find where we have put awful illogical heavy junk instead of a more elegant
simple solution with almost identical semantics. our codebase is getting gross man." A cut qualifies
only when a much simpler shape keeps almost identical semantics. It must name exactly what changes,
and must not drop a real guarantee (security walls, loop limits, delivery guarantees, data safety)
unless it keeps that guarantee more simply.

## How the sweep ran

A read-only workflow ran against origin/main on 2026-09-29, about cfd8a1d36:

1. **Areas.** The monorepo was split into 15 areas: the platform's DO core, the edge and API, context
   built-ins, routing, streams, control plane and integrations, project/repo/secret, scripts and
   env, CI, the SDK, the packages, the UI, the big and small clients, and test infrastructure plus
   lint.
2. **Hunts.** Each area was hunted twice. One lens looked for parallel mechanisms and duplicate
   concepts; the other for heavy machinery, expired workarounds, defensive code for impossible states
   and walls of comments.
3. **Cross-cutting pass.** One pass deduplicated the candidates and added repo-wide patterns (the
   same job done N ways across packages).
4. **Verification.** Every candidate went to an adversarial skeptic, who checked that the semantics
   are really near-identical, that the new shape is really simpler, and that no guarantee is dropped,
   and who re-measured the LOC. 81 of 99 survived, many with an amended proposal.

## What already landed

Two batches came out of this work, and both are merged and live on prd.

**#3460, the no-brainers.** Eight bug fixes:

- A person's own facet rows could mask the platform's grant-revocation read, and could break
  `projects.delete`. Platform reads now go through the fixed point.
- A replaced cursor loop kept delivering to its fan-out replacement.
- An alarm could hold one 8 MiB page per owed row.
- A stale target evaluation could overwrite a replaced row.
- A call on an older facet generation could lose its FACET_* code.
- A lend row with extra arguments was never removed.
- The LOC report stripped comments wrongly.
- admin.iterate.com's 5xx never paged.

It also carries five dedupes: one sha256Hex, fflate instead of hand-written zip code, one petshop
TTL constant, deployApp's dead knobs removed, and `elapsedBetween` formatted with `formatDelta`.

Codex's review of #3460 dropped seven items because each changed behaviour: 56, 62, 78, 13, 28, 58
and 95. Its builders skipped 7, 10, 15, 16, 48, 50, 52, 57, 77, 87, 89 and 97, with their reasons in
the per-area files.

**Also held from that pass, as policy changes:**

- **The deadlines() half of 23.** Rows with no claim would stop deepening an alarm's wake cause.
- **Deleting the route digest from 24.** A republished fix would stop retrying failed deliveries at
  once. That retry is a feature from #3425. Only 24's stale-row guard landed.

## The calls (Jonas decides; recommendations inline)

1. **urls.os becomes required (#1, −234).** A self-host with it blank fails at boot. A workers.dev
   self-host passes `isPreviewOrLocalOrigin`, and plain http gets a 421 without a 2-line redirect.
   Rec: yes; narrow the guard to `*.iterate-dev-preview.workers.dev` and keep the redirect.
2. **Delete the platform hook (#2, −66).** It is a birth row on every context that delivers every
   durable event to a platform target that does nothing today, at the cost of one SHA-256 per event.
   Jonas said on 2026-09-28 "we want the platform hook for sure". Rows born on prd since #3425 would
   dangle until a sweep. Rec: delete, unless a concrete use is planned.
3. **Cursor rows get durable events only (#16, −486).** This reverses rein-in 11 §1.3: a cursor row
   that names an ephemeral type would stop getting it. Fan-out rows already refuse ephemerals, and
   no first-party cursor row uses one. Rec: yes, and refuse such a row when it is configured rather
   than starving it silently.
4. **Slice cross-context waits once, in contextStub (#80, −215).** This replaces four hand-written
   copies, one of them in packages/agents. An idle wait costs one subrequest per 5 s: 24 of a
   WebSocket's 1,000 for a 120 s wait. Rec: yes.
5. **Publication's per-attempt bound (#30).** 60 s never cuts a cold esm.sh resolve but gives up at
   about 215 s. 20 s gives up at about 95 s but cuts resolves that take 20 to 60 s. Rec: 60 s.
6. **The delivery policy halves of 23 and 24,** described above under "Also held". Rec: keep both
   as they are.
7. **Account moves recover forward only, and Slack's held token goes (#21 and #22, −668).**
   - There is no provider re-proof at confirm time.
   - A platform fault after the route moves is retried forward, not undone.
   - An unconfirmed Slack move leaves a refused token and a `secret/set` fact.

   Rec: yes, both together.

8. **One D1 boundary for the control plane (#23, −187).** /api's UNAVAILABLE messages would name
   sqlfu statements (`userByRef`) instead of verbs. Rec: yes, with a one-line map back to verb names.
9. **The admin secret is accepted only in-band (#5, −45).** `Authorization: Bearer <admin secret>` at
   /api starts answering 401, and docs advertise that form. Rec: yes, and fix the docs; no backcompat.
10. **Published SDK shapes change (#4, #27, #45).** `IterateApi.consent` and `ConsentAnswer` go
    (test-only today), `workspace.mounts()` returns `string[]`, and `useLiveState` leaves
    `iterate/react`. Rec: yes.
11. **One appEnvs map in envs.ts (#32, −158).** This reshapes envs.ts, which jonasland-rules asks the
    owner to confirm. Rec: yes.
12. **Main OS e2e becomes Preview OS's push trigger (#38, about −400).**
    - Every PR shows a skipped "Page a change of state" check.
    - Main's fresh-deploy dispatch goes.
    - The page state restarts once.

    The merge has five traps; the amended YAML in ci.md fixes them. Rec: yes, but as the last PR.

13. **CI pages go through keepPage (#42, −41).** Kit firmware loses its re-ping when its set of
    failing jobs changes. Rec: yes.
14. **Delete the Doppler prefetch (#36B).** It was added in #3294 to cut about 0.3 s. Rec: only if a
    soak shows the tail is unchanged.
15. **Context-view extras from #3144 (#53, #56, #57).**
    - #53: the Examples menu goes.
    - #56: the processors sheet's Pretty view goes, so agent state renders as full YAML on every
      update while the sheet is open.
    - #57: the pretty-raw mode goes.

    Rec: drop Examples and pretty-raw; keep Pretty.

16. **The Chat tab's raw composer goes (#61).** Jonas asked for it on 2026-09-17 for apps/os parity.
    Raw appends would stay in the Events tab. Rec: remove it.
17. **The chat input becomes a textarea (#63).** On iOS it gains spellcheck and autocorrect. Rec:
    yes, with those attributes turned off.
18. **Delete configs/heartbeat (#66, −205).** It was kept on Jonas's behalf, never by his call.
    Deleting it also drops the picker entry and the PR quick-launch row, and the default's AGENTS.md
    gets a 4-line snippet. Rec: delete.
19. **Kit discards the old session on a failed sign-out (#67).** This reverses #3060's "forgetting
    stays the person's call". Rec: no, keep today's behaviour.
20. **Kit checks its flash layout at build time only (#68, −217).** Nothing would then check that
    srmodels.bin fits its partition (291 KB in 4 MiB today). Rec: yes.

**Smaller one:** the CLI's single lend loop (#49, −95) removes a tunnel's route just after exit
unless it keeps a 6-line stop hook. Rec: yes, and keep the hook.

## Top 10 findings (worst first)

**1. The platform origin is carried seven ways because `urls.os` is optional** (#1, #3)

- **What's heavy:** it is carried by:
  - `Caller.platformOrigin`;
  - the `x-itx-platform-origin` header;
  - an `ItxEntrypoint` prop;
  - a per-context learned kv row, plus `#withPlatformOrigin` wrapped around 8–9 call sites;
  - a second stub memo;
  - the origin inside every loader id.
    On top of that there are five "call it from a session" refusals, 199 references in all. Every deployment we run already sets `urls.os`; only a self-host that leaves it blank needs any of this.
- **Simpler shape:** `urls.os` becomes required, and code reads `appConfig.urls.os`. In the same PR, drop the context's kv copy of its project slug, because whoami already reads that row through the 5 s edge cache.
- **What changes:** a blank value fails at boot, so the live self-host must add one line before it redeploys.
- **LOC:** −234

**2. Cursor rows deliver ephemerals from the ring** (#16)

- **What's heavy:**
  - a memory cursor that runs ahead of the stored one, with a clamp;
  - a ring-sized at-mark reserve;
  - a restart after the wait, with a hand re-arm of the alarm (`claimArmsTheAlarm`);
  - a per-type eviction ledger that exists only to log a warning.
    All of it is best-effort and is lost on any eviction. Twenty lines earlier in the same file, fan-out rows already refuse ephemerals for exactly that reason, and no first-party cursor row consumes one.
- **Simpler shape:** cursor rows get durable events only; ephemerals go to facets and live callbacks.
- **What changes:** a cursor row that names an ephemeral type stops getting it, silently. This reverses rein-in 11 §1.3.
- **LOC:** −486 (−91 of that in product code)

**3. "Slice a wait into fresh 5 s calls" is written by hand four times, once in userspace** (#80)

- **What's heavy:** the four copies are:
  - `agentCertificate` in packages/agents;
  - `#terminalFact`;
  - `settlementOfScriptRun`;
  - the e2e `publishConfigWorker`.
    Together they need 6 constants, 3 warn events, and an `itx/woken`-in-the-filter trick so the move can be logged. Long waits that nobody sliced are still exposed: upgrades, voice install, and the model's own scripts.
- **Simpler shape:** one slicer in `contextStub`, for `waitForEvent` calls with an explicit `afterOffset`. Each caller becomes a single `waitForEvent`.
- **LOC:** ≈ −215

**4. `ControlPlane` re-declares 26 catalog methods, 8 of them under a second name** (#23, #24)

- **What's heavy:** 26 forwarders, `callerOf`, and 42 wrapper sites, all so that D1 failures map to UNAVAILABLE and /api's read deadline applies.
- **Simpler shape:** one failure boundary at the D1 chokepoint (the sqlfu client and `batch`). `ControlPlane extends ControlPlaneDatabase` and keeps only the 12 overrides that cache, forget or decide.
- **Required fix:** `linkIdentity`'s unique-violation catch must read `.cause`.
- **LOC:** −187

**5. Moving an integration account has a compensating undo and a second wall** (#22, #21)

- **What's heavy:**
  - When the connect fails after the route has moved, a compensating undo runs. Three race guards hold it together, and it drags in `restoreIntegrationRoute` (SQL, catalog, edge and generated code), `connectionRowThroughHeadOf`, a second release in disconnect, and a `moving` lock. A failed holder cleanup, by contrast, already retries forward.
  - Slack also parks the token in a `held` slot, with admit and drop at three layers, an alarm and a revive override. The route guard at use time already refuses that token anyway.
- **Simpler shape:** all expected refusals happen before the route moves. After it, only idempotent writes follow, and the same offer finishes them. Every Slack token is stored, and the use guard is the one wall.
- **LOC:** −668 (−357 of that in product code)

**6. Facet-row outcomes are decided in four places that have drifted, and row identity is checked three ways, one of them wrong** (#17, #18)

- **What's heavy:**
  - NO_FACET is silent on push but raises an issue on resume.
  - Evaluation errors never halt the row, but call errors do.
  - A cursor-presence stand-in for "is this still the row?" lets a cursor loop that was replaced by a fan-out row overwrite that row's cursor and send it batches. This was proven red.
- **Simpler shape:** one `#facetRowFailed(action, …)`, and `#isStillTheRow` used everywhere.
- **LOC:** −56 source, +65 tests

**7. Fan-out rows persist an FNV digest of where their target resolved** (#20)

- **What's heavy:** every evaluation stringifies its route, which can carry a whole worker source, hashes it, and compares the hash with one stored on the cursor. When they differ, every pending retry is pulled forward to now. As a result, each republish of a config that is still broken burns one attempt from every pending event.
- **Simpler shape:** `evaluate()` returns `{ value, validUntil }`, and each retry keeps its rung.
- **LOC:** −77

**8. The edge keeps second entry points that nobody uses** (#4, #5)

- **What's heavy:**
  - `session.consent` over /api is only called by tests. It needs a per-connection RpcTarget, a mode flag, a grant re-read, and a published type (`ConsentAnswer`) that has already drifted.
  - The admin secret also works as an OAuth bearer that mints `grant: null`. That forces refusals on four other paths and `?.grant` guards everywhere.
- **Simpler shape:** consent goes only through the issuer page; the admin secret is accepted only in-band; `Authorization.grant` becomes non-null.
- **LOC:** −103, or −226 with the rest of its batch

**9. Main OS e2e is a 414-line copy of Preview OS, kept in step by a parity test** (#38)

- **Simpler shape:** preview-os.yml gets a push trigger with `DEPLOYMENT_PREFIX=main`, and the alert job moves over.
- **What to watch:** done naively, the merged workflow silently tests the previous commit. There are five places where this goes wrong: `PREVIEW_AWAIT_DEPLOY_JOB` is empty on push, the step-level prefix overrides the workflow's, the job `if`s exclude push, the checkout ref breaks, and a main-only step is missing. The amended YAML fixes all five and needs push rows in the tests.
- **LOC:** ≈ −400

**10. The Agents page re-folds the whole log every frame through leftovers from when the fold ran on the server** (#58, #62)

- **What's heavy:**
  - two bespoke stub hooks that predate `useContextStub`;
  - a JSON clone plus zod parse of the entire log on every publish;
  - a second live-state subscription to `agent`;
  - a copied `StreamEvent` type;
  - a sharded `ChunkedText` rope with a wire schema nothing sends. Its sharing never reaches React, because the feed re-folds from scratch.
- **Simpler shape:** `useContextStub` twice, one `useIterateContext`, the SDK types, and streamed text as a string plus a tail offset.
- **LOC:** −237. The rest of the Agents batch adds −507: a CodeMirror input kept for mention pills that no longer exist, a 98-line clock framework for one label, an unused 6-phase status machine, and a second raw composer.

**Next in line:**

- #32 appEnvs; as it stands, admin.iterate.com never pages.
- #37, DO cost's Slack-history page keeper: −300.
- #56, a hand-written CoreState reader that breaks validate-unknown-shapes: −293.
- #79, the expected-fail shim copied twice: −300.
- #71, 13 Workers session openers: −200.

**Bugs these cuts also fix**

- **#76:** a person's own `itx.facets` row on /users/<id> can mask or redirect the grant-revocation read and the platform-fact barrier. This follows from the resolver but is not yet proven, so write the red row first.
- **#18:** a replaced cursor loop runs against the new fan-out row. Proven red.
- **#32:** admin is missing from PRD_WORKERS, so its 5xx never page.
- **#28:** a delegated sub-zone under a Domain Connect parent gets a link that writes into the parent zone, where the records never resolve.
- **#19:** the alarm pass can hold one page of up to 8 MiB for each owed row at the same time.
- **#7:** `describeReach` tells a consent-narrowed grant that it reaches "the projects of the orgs X belongs to", which is misleading.
- **#10:** a call still in flight on an older facet generation can lose its FACET_* code.
- **#14:** a lend row with extra arguments is counted by the wake census but is never removed.

## All 81 verified candidates

| #   | Title                                             | Area                    | LOC            | Concepts before → after                                                    | Risk     | Payoff |
| --- | ------------------------------------------------- | ----------------------- | -------------- | -------------------------------------------------------------------------- | -------- | ------ |
| 1   | `urls.os` required                                | os-do-core              | −200           | 7 origin carriers + 5 refusals → 1 config value                            | low–med  | 6      |
| 2   | Delete the platform hook                          | os-do-core              | −66            | module, implicit root, birth row, type carve-out → 0                       | low      | 4      |
| 3   | Drop the context's kv slug copy                   | os-do-core              | −34            | 2 caches of one row → 1                                                    | low      | 3      |
| 4   | Consent only via the issuer page                  | os-edge-api             | −58            | 2 entry points, 2 view types, 1 flag → 1, 1, 0                             | low      | 5      |
| 5   | Admin secret only in-band                         | os-edge-api             | −45            | 2 spellings, nullable grant, refusal reason → 1                            | low      | 5      |
| 6   | CreateWaits → watchSlowStep                       | os-edge-api             | −40            | 2 slow-step loggers → 1                                                    | low      | 3      |
| 7   | MCP holds a session                               | os-edge-api             | −18            | private project guard, caller, dispatch → session                          | low–med  | 4      |
| 8   | Exact sign-in challenge header                    | os-edge-api             | −65            | RFC 9110 challenge parser → 1 string                                       | low      | 4      |
| 9   | Facet public methods via listPublicMethods        | os-context-builtins     | −25            | 2 method sources, 2 name tables → 1, 1                                     | low      | 3      |
| 10  | A facet generation records its own ending         | os-context              | −18            | 3 maps, 2 abort idioms, 5 live-set sites → 1 field, 1 helper               | low–med  | 4      |
| 11  | copiedOffSession + releaseRpcSessions             | os-context              | −22            | 5 copy-out blocks, 3 disposers → 1, 1                                      | low      | 4      |
| 12  | Revive failures kept in the claim row             | os-context-builtins     | −19            | 2 row kinds, 2 maps, 2 sync helpers → 1 row, 1 map                         | low      | 4      |
| 13  | A facet start is bounded once                     | os-context-builtins     | −8             | policy type, constant, 2 nested bounds → nullable ms                       | low      | 3      |
| 14  | fixedPointOf                                      | os-context-routing      | −29            | 6 try/catch wrappers, 3 lend recognisers → 1, 1                            | low      | 3      |
| 15  | Drop the append-time self-link refusal            | os-context-routing      | −174           | 2 loop guards + `ownPath` param → hop count                                | low      | 4      |
| 16  | Cursor rows get durables only                     | os-stream               | −486           | 6 ring mechanisms → 2                                                      | low–med  | 6      |
| 17  | One facet-row failure decision                    | os-stream               | −28            | 4 partial classifiers → 1                                                  | low–med  | 5      |
| 18  | One "still the row" check (bug)                   | os-stream               | +39 (src −16)  | 3 identity spellings → 2                                                   | low      | 4      |
| 19  | owedCause reads deadlines()                       | os-stream               | −8             | 2 "due" rules, N pages held → 1, 1 page                                    | low      | 3      |
| 20  | Drop the FNV route digest                         | os-stream               | −77            | routedTo, stored digest, FNV, retry-now → 0                                | low      | 5      |
| 21  | Slack token stored; the use guard is the wall     | os-control-integrations | −218           | held slot, 3-layer admit, alarm, revive → use guard                        | med      | 5      |
| 22  | A failed move recovers forward                    | os-control-integrations | −450           | undo with 3 race guards + forward retry → forward retry; 7 route verbs → 6 | med      | 5      |
| 23  | ControlPlane stops re-declaring the catalog       | os-control-integrations | −175           | 26 forwarders, 2 names, 3-level wrapper → 1 D1 boundary + 12 overrides     | med      | 6      |
| 24  | One project admission                             | os-control-integrations | −12            | 2 admissions that call each other → 1                                      | low      | 3      |
| 25  | Template reader uses git-wire                     | os-project-repo-secret  | −72            | 2 git HTTP clients → 1                                                     | low      | 4      |
| 26  | A PAT's end recorded once                         | os-project-repo-secret  | −17            | 2 records + ordering rule → 1                                              | low      | 3      |
| 27  | A workspace mount is its repo path                | os-project-repo-secret  | −15            | 2 names for one path → 1                                                   | low      | 3      |
| 28  | DNS zone found once                               | os-project-repo-secret  | −72            | 2 zone ladders, 2 DoH readers, fallback → 1, 1, 0                          | low–med  | 4      |
| 29  | MCP/capnweb: one session slot                     | os-project-repo-secret  | −30            | 7 fields (generation, flags, memos) → 2 slots                              | med      | 4      |
| 30  | Publication uses the shared retry                 | os-project-repo-secret  | −6             | private ladder + race timer → named schedule                               | med      | 3      |
| 31  | ProjectProcessor: required reaches                | os-project-repo-secret  | −7             | 2 creation flows, 3 nullable reaches, 3 state copies → 1, 0, 1             | low      | 4      |
| 32  | One `appEnvs` map                                 | os-scripts-env          | −158           | 6 maps, 4 types, 3 hand lists, guard test → 1 map + AppEnv                 | low      | 6      |
| 33  | preview.ts: methods are the commands              | os-scripts-env          | −42            | enum, all-flags bag, forwarder, re-dispatch, wrapper, dead command → class | low      | 4      |
| 34  | deployApp's dead knobs                            | os-scripts-env          | −36            | afterDeploy, UNPROVISIONED, assertProvisioned → 0                          | low      | 3      |
| 35  | Specs warm-up awaited in setup                    | os-scripts-env          | −80            | detached group, env scrub, stop protocol, span → 1 awaited step            | low      | 4      |
| 36  | Evidence: no shell fallback reporter (B optional) | ci                      | −111 (B: −120) | marker handshake + shell reporter → in-process report                      | low      | 4      |
| 37  | DO cost pages kept in health state                | ci                      | −300           | 2 page stores (marker, windows, peak regex) → 1                            | low–med  | 5      |
| 38  | Main OS e2e = Preview OS push trigger             | ci                      | −400           | 2 workflows + parity test → 1                                              | med–high | 6      |
| 39  | Finalizer verdict passed in memory                | ci                      | −66            | 2 manifests, 2 loads, 2 foreign rules → 1 each                             | low      | 4      |
| 40  | fflate for zips                                   | ci                      | −77            | 2 hand-written codecs → 0                                                  | low      | 4      |
| 41  | @octokit/auth-app for the flake dashboard         | ci                      | −35            | 2 JWT signers → 1                                                          | low      | 2      |
| 42  | notify.ts pages via keepPage                      | ci                      | −41            | 2 page keepers → 1                                                         | low      | 4      |
| 43  | Evidence upload via mapConcurrent                 | ci                      | −41            | 2 pools → 1                                                                | low      | 3      |
| 44  | loc-report strips comments via oxc                | ci                      | −39            | hand lexer + parser → parser                                               | low      | 3      |
| 45  | `watchFacetLiveState`                             | sdk                     | −87            | 3 lifecycle copies, 3 seed parsers → 1, 1                                  | med      | 4      |
| 46  | `#reduceFromLog`                                  | sdk                     | −23            | 2 page loops, flag, extra slot, per-entry re-reduce → 1 walk               | low      | 4      |
| 47  | One `#shownHeadOffset`                            | sdk                     | −15            | 2 heads, merge, caveat → 1 head                                            | low      | 3      |
| 48  | defineProcessorContract: one table                | sdk                     | −12            | Set + per-lookup walk + doubled type → 1 table, 1 type                     | low      | 2      |
| 49  | CLI: one lend loop                                | packages-apps           | −95            | 2 loops, 2 ladders, 2 route lifetimes → 1 each                             | low      | 4      |
| 50  | Voice idle stamp kept in memory                   | packages-apps           | −34            | stepped durable stamp, mirror, 2 clocks, 2 dead fields → 1 stamp           | low      | 4      |
| 51  | packages/ui navigates via the router              | ui                      | −71            | onNavigate protocol, locationKey, navigateToPath, 3 lambdas → RouterAnchor | med      | 4      |
| 52  | Context view uses the SDK's types                 | ui                      | −77            | 5 structural copies (1 drifted) → 0                                        | low      | 4      |
| 53  | Drop the Examples menu                            | ui                      | −121           | 2 ways to offer consumed types + grouping → completion                     | low      | 3      |
| 54  | The filter is the URL state                       | ui                      | −52            | 2 filter shapes + converter → 1                                            | low      | 3      |
| 55  | elapsedBetween = formatDelta                      | ui                      | −18            | 2 gap formatters → 1                                                       | low      | 2      |
| 56  | Processors sheet shows YAML only                  | ui                      | −293           | 2 stacked toggles, hand CoreState reader, field lister → 1 block           | low      | 4      |
| 57  | Drop the pretty-raw mode                          | ui                      | −7             | 3 modes (1 URL-only) → 2                                                   | low      | 2      |
| 58  | Agents page uses SDK hooks and types              | clients-big             | −82            | 2 stub hooks, per-frame reparse, 2nd subscription, copied type → 0         | low–med  | 6      |
| 59  | Live tail label is one function                   | clients-big             | −156           | 6-phase machine, 2nd log scan, unvaried option → 1 function                | low      | 4      |
| 60  | 98-line clock → useState                          | clients-big             | −95            | shared external-store registry → state + interval                          | low      | 4      |
| 61  | Drop the Chat-tab raw composer                    | clients-big             | −124           | 2 raw-append composers, 2 modes → 1, 1                                     | low      | 4      |
| 62  | Streamed text is a string                         | clients-big             | −155           | rope, wire schema, group level, 2 representations → string + offset        | low–med  | 5      |
| 63  | Chat input is a textarea                          | clients-big             | −132           | lazy CodeMirror (5 mechanisms) → textarea                                  | low–med  | 5      |
| 64  | Org-tree reload is two promises                   | clients-big             | −17            | 2 counters, flag, waiter list → 2 promises                                 | low      | 3      |
| 65  | Dash stops enabling folds on page view            | clients-big             | −23            | 2 enablers → 1                                                             | low      | 3      |
| 66  | Delete configs/heartbeat                          | clients-small           | −205           | 3 templates, 2 copies of the email filter → 2, 1                           | low      | 4      |
| 67  | Kit discards the session on a failed end          | clients-small           | −97            | 2 failure policies + forget route → 1                                      | med      | 3      |
| 68  | Kit flash layout checked once                     | clients-small           | −217           | 3 validators + path rewrite → ESP-IDF + 1 rule                             | low      | 4      |
| 69  | Kit UI state in useState                          | clients-small           | −18            | query cache as UI store → useState                                         | low      | 3      |
| 70  | Petshop TTL as one constant                       | clients-small           | −15            | 3 spellings of 120 s → 1                                                   | low      | 2      |
| 71  | Workers suite: one session opener                 | test-infra-lint         | −200           | ~13 openers, 4 disposal regimes → 1 rule + 2 openers + 1 exception         | low–med  | 5      |
| 72  | Built-in no-implied-eval                          | test-infra-lint         | −36            | custom rule → built-in                                                     | low      | 2      |
| 73  | e2e target as one value                           | test-infra-lint         | −79            | 9 env/provide names, schema, double JSON → 1 type                          | low      | 4      |
| 74  | Inline the presence fixture                       | test-infra-lint         | −106           | triplet, disk loader, unit test, knip exception → 1 entry                  | low      | 3      |
| 75  | Tags are the registry                             | test-infra-lint         | −48            | 2 registries, exactness test, stale detector → tags                        | low      | 4      |
| 76  | Platform facet reads at the fixed point           | cross                   | −5             | 2 spellings + maskable route → 1 helper                                    | low      | 4      |
| 77  | One sha256Hex                                     | cross                   | −38            | 3 SHA-256 copies + djb2/FNV → 1                                            | low      | 3      |
| 78  | Cloudflare API returns whole listings             | cross                   | −43            | 7 listing strategies → 1 rule (R2 buckets still refused)                   | med      | 5      |
| 79  | One expected-fail mechanism                       | cross                   | −300           | 2 copies of the runner shim + dead helper → 1                              | low      | 4      |
| 80  | Wait slicing on the call path                     | cross                   | −215           | 4 slicers, 6 constants, 3 warns, woken trick → 1 slicer                    | med      | 6      |
| 81  | Unknown flake records written once                | cross                   | −165           | 2 runner writers + count + reconciliation → 1 writer                       | low      | 4      |

Rows that landed (fully or in part) in #3460, by the numbers above: 76, 18, 19, 20 (its stale-row
guard only), 14, 10, 32 (the admin paging fix only), 44, 55, 70, 40, 77, 34.

## PR batches (payoff over risk)

| #   | PR                                                                     | Rows                   | LOC  | Risk     | Depends on                                                                                   |
| --- | ---------------------------------------------------------------------- | ---------------------- | ---- | -------- | -------------------------------------------------------------------------------------------- |
| 1   | Platform facet reads at the fixed point (red Workers row first)        | 76                     | −5   | low      | —                                                                                            |
| 2   | One `appEnvs` map                                                      | 32                     | −158 | low      | your OK                                                                                      |
| 3   | Delivery rows: one outcome decision, one row identity, no route digest | 20, 17, 18, 19         | −74  | low      | —                                                                                            |
| 4   | Edge: one entry point each                                             | 4, 5, 8, 6, 7          | −226 | low      | —                                                                                            |
| 5   | Agents client leftovers                                                | 58, 62, 63, 59, 60, 61 | −744 | low–med  | manual browser drive (no specs cover it)                                                     |
| 6   | Cursor rows get durables only                                          | 16                     | −486 | low–med  | 3 (same file); your call                                                                     |
| 7   | Test telemetry: one writer, one registry                               | 81, 39, 36A, 43, 75    | −431 | low      | —                                                                                            |
| 8   | Routing: one fixed-point reader, one loop guard                        | 15, 14                 | −203 | low      | —                                                                                            |
| 9   | Facet host                                                             | 11, 13, 10, 12, 9      | −92  | low      | —                                                                                            |
| 10  | Test-support helpers and e2e target                                    | 79, 73, 74             | −485 | low      | —                                                                                            |
| 11  | Context-view kit                                                       | 52, 54, 55, 57, 53, 56 | −568 | low      | your call on 53/56/57; 52 lands first                                                        |
| 12  | CLI: one lend loop                                                     | 49                     | −95  | low      | —                                                                                            |
| 13  | Voice agent: in-memory idle stamp                                      | 50                     | −34  | low      | —                                                                                            |
| 14  | SDK stream engine                                                      | 46, 47, 48             | −50  | low      | 47 on top of 46                                                                              |
| 15  | Workers suite: one session opener                                      | 71                     | −200 | low–med  | 10 (both edit e2e/support/client.ts)                                                         |
| 16  | Slack pages: health state + keepPage                                   | 37, 42                 | −341 | low–med  | —                                                                                            |
| 17  | Preview and deploy tooling                                             | 33, 35, 34, 78         | −201 | low–med  | 2, 7 (preview.ts)                                                                            |
| 18  | `urls.os` required, no slug cache                                      | 1, 3                   | −234 | low–med  | 1; the live self-host sets urls.os first                                                     |
| 19  | Control plane: one D1 boundary, one admission                          | 24, 23                 | −187 | med      | 4 (edge.ts)                                                                                  |
| 20  | Cross-context waits sliced once                                        | 80                     | −215 | med      | 1, 9 (context-stub.ts)                                                                       |
| 21  | CI: use the library                                                    | 40, 44, 41, 72         | −187 | low      | —                                                                                            |
| 22  | Small clients: Dash + petshop                                          | 64, 65, 70             | −55  | low      | —                                                                                            |
| 23  | apps/os leaf dedupes                                                   | 25, 77, 26, 29, 27     | −172 | low–med  | 18 (worker-loader.ts); SDK OK for 27; check no open PR also bumps the account contract to 10 |
| 24  | Project processor and DNS                                              | 31, 28, 30             | −85  | low–med  | pick the attempt bound for 30; live Cloudflare + GoDaddy check for 28                        |
| 25  | Kit                                                                    | 68, 69, 67             | −332 | low–med  | your call on 67                                                                              |
| 26  | Account moves recover forward only                                     | 21, 22                 | −668 | med      | design both together; your call                                                              |
| 27  | Delete configs/heartbeat                                               | 66                     | −205 | low      | your call                                                                                    |
| 28  | Delete the platform hook                                               | 2                      | −66  | low      | your call; one operator sweep on prd                                                         |
| 29  | packages/ui navigates via the router                                   | 51                     | −71  | med      | Voice unmount hang-up in the same PR                                                         |
| 30  | SDK: `watchFacetLiveState`                                             | 45                     | −87  | med      | 5 (drop its agents-page part)                                                                |
| 31  | Main OS e2e becomes a Preview OS trigger                               | 38                     | −400 | med–high | 16 (monitors/health.ts), 2 (preview-sweep)                                                   |

## Totals

- **Net LOC:** ≈ −7,360 across 81 rows, including tests, CI and scripts. With the optional Doppler-prefetch deletion (#36B) it is ≈ −7,480. Rows that touch the same files overlap by tens of lines.
- **Concepts removed:** ≈ 260. That counts maps, flags, helpers, types and parallel mechanisms, summed from each row's before → after.
- **Bugs fixed along the way:** 8. One of them (#76) is a latent auth hole.

## Checklist to resume

- [ ] Jonas answers the 20 calls, taking the recommendations with any overrides.
- [ ] Re-base the per-area notes on main: #3442, #3455 and #3460 moved some lines, and 13 rows
      already landed.
- [ ] Ship the batches in order, one PR each. Each gets red-first rows for behaviour it keeps, a
      Codex review, and LOC in the body.
- [ ] Move this file to `tasks/complete/` when the last batch lands or is dropped.
