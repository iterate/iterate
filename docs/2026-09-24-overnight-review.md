# Overnight review, 2026-09-24: what is left for a decision

On the night of 2026-09-23, 24 reviewers read the whole repository and produced 531 verified findings. The clear ones are merged: about twenty PRs between #2933 and #2952. The ones that touch an API, auth or persisted state are open for review: [#2950](https://github.com/iterate/iterate/pull/2950) (backwards compatibility in persisted and auth state), [#2951](https://github.com/iterate/iterate/pull/2951) (validation gaps) and [#2953](https://github.com/iterate/iterate/pull/2953) (SDK names and one-of-two API shapes). This document is the rest: 228 findings that no PR took, re-checked against main at `0aaa8ae4b`, with the ones already fixed tonight removed (appendix B) and duplicates merged. It also answers a second question: whether the cleanup threw out Misha's work on TypeScript, lint, Playwright and CI ([section 8](#8-mishas-investments)).

It is a discussion document. Once the decisions below are made, the items should become issues or PRs and this file should be deleted, not kept as history.

## TL;DR

The codebase is in better shape than the finding count suggests: most findings were drift left by fast merges, and most of that is fixed. What remains falls into a few groups. In priority order:

1. **Fix three small, live problems nothing tonight touched.** Every interrupted agent run renders as "The durable script settlement is invalid." ([C1](#c1-interrupted-agent-runs-render-as-an-invalid-settlement)). `itx.agents.create(path, { creator })` lets a caller choose the new agent's parent link ([C2](#c2-a-caller-can-choose-a-new-agents-parent-link)). The flake dashboard's GitHub App key lives in the Doppler project `os-legacy-backup`, which looks safe to delete but isn't ([C3](#c3-live-ci-credentials-in-legacy-doppler-projects)).
2. **Turn on a merge queue.** A green PR turned main red three times in 36 hours, and once shipped a broken dash to prd ([decision 3](#decisions-only-you-can-make)).
3. **Replace git-blame lint grandfathering with a checked-in baseline.** It forces full-history clones in CI, makes local lint slow or crash, and turned main red tonight at the midnight cutoff ([I2](#i2-replace-blame-based-grandfathering-with-a-checked-in-baseline)).
4. **Take residency out of the 1,408-line context Durable Object**, and write one page that explains the seven residency mechanisms together ([A1](#a1-take-residency-out-of-the-context-durable-object), [A2](#a2-one-account-of-the-residency-mechanisms)).
5. **Draw the SDK/platform line.** Platform dispatch internals ship as SDK API, the SDK's engine tests live in apps/os, and there are two ~700-line git protocol codecs ([A3](#a3-put-the-sdks-tests-and-harness-in-the-sdk)–[A5](#a5-one-git-protocol-implementation)).
6. **Delete what feeds nothing.** The CI PostHog event pipeline (about 1,470 lines; delivery has been zero since #2494), the legacy CI-trace shapes, the menubar's approval code and the daily `release.yml` ([decisions 4, 5, 8](#decisions-only-you-can-make), [B1](#b1-ci-trace-tooling-still-models-the-deleted-preview-runyml-pipeline)).
7. **Build the Start-app skeleton once.** Five apps repeat the server entry, root, router and `Env` declaration by copy ([A7](#a7-build-the-start-app-skeleton-once)).
8. **Misha's investments are mostly intact.** The real losses are the report viewer for traces and Playwright reports, preview work selection, main-branch traces and Playwright evidence, the review bot that enforced `rules/**`, and the spec harness's operator handle. Several things are present but not doing their job: `createFailing` has no caller, the telemetry completeness guarantee has no writer, and knip covers 5 of 13 workspaces (being fixed).

## How to read this

- **Priority.** P1: fix soon (a live bug, a security gap or an operational trap). P2: worth scheduling. P3: do it when you are working in that area.
- **Effort.** S: one small PR. M: one PR of a day or two. L: a series of PRs.
- **Ids.** Items carry the review's finding ids in parentheses; [appendix A](#appendix-a-finding-ids) maps each to one line. `ci-audit` ids come from the separate CI audit. Line numbers are against main at `0aaa8ae4b`.
- **In flight** means a PR that was open or being written when this was written: #2950, #2951, #2953, plus four PRs from the same run that had not been opened yet: `ci-lint-tooling-cleanup` (budgets, dead knip and lint config, tracing leftovers), `checks-cover-everything` (knip on every workspace, every TS file typechecked, the `no-shouting-constants` cutoff, `typed-no-floating-promises`), `docs-sweep` (stale testing, CI and dev-environment docs) and the internal `os-next` rename, which runs last.

## Decisions only you can make

1. **Sign off the Kit firmware release contract.** Kit now flashes per-device GitHub releases (#2934, #2948), and Deploy Kit went from 449 s to 41 s. The public contract is the tag `kit-firmware/<device-id>/<version>`, the version `<first-parent commit count, 6 digits>-<UTC date>-<sha7>` (for example `002587-2026-09-24-a71e27c`), and a `manifest.json` in esp-web-tools format with one extra field, `configurationPartition`. **Recommendation: sign it off as written**, then do three things. Add the `kit-firmware/**` tag ruleset: the repo has no tag ruleset, and "Required CI" is its only active ruleset. Bench-flash one board: verification stopped at the manifest the page hands to esp-web-tools. Redeploy the `kit-preview` parent Worker. Preview parents are deployed only when missing ([`apps/os/scripts/preview.ts:432`](../apps/os/scripts/preview.ts#L432)), and this one still answers 404 for a release manifest that `k.iterate.com` serves.
2. **Decide what to do with the deployed names left from the two-platform era:** the Workers `os-next-prd` and `os-next-preview`, the Artifacts namespaces `os-next-*-repos`, the prd resource prefix `project-worker-prd` (why `resourceNamePrefix` exists in [`envs.ts`](../envs.ts#L86-L88)) and the Doppler project `project-worker`. **Recommendation:** leave prd as it is until prd is next recreated, then create resources under the Worker's name and delete `resourceNamePrefix`. Rename the preview parent only together with the next preview-infrastructure change, since previews are disposable. Do not rename the Doppler project: document the mapping once in `docs/dev-environments.md`. #2953 already moves the OS build from `OS_NEXT_ENV` to `CLOUDFLARE_ENV`. (naming-homogeneity#3, prs-restores#26, backcompat-sweep#23, os-scripts#10)
3. **Turn on a merge queue.** Required checks run on the PR head, and the "Required CI" ruleset does not require branches to be up to date. A green PR turned main red three times in 36 hours:
   - #2900 × #2888: Lint was red for 11 minutes. Deploy Dash does not wait for Lint, so it shipped a `ReferenceError` to the prd dash.
   - #2904 × #2920: Test was red for 18 minutes, and five PR runs failed on the red base.
   - Tonight, #2935: its branch commits predated the lint grandfather cutoff and its squash commit did not. Fixed by #2942.

   **Recommendation: yes.** Add `merge_group` to `lint-typecheck.yml` and `test.yml`, confirm with one test PR that Depot dispatches it, then add the queue rule (squash, batches of 3–5). While you are in the rulesets: the older "Protect Main branch" ruleset (no force push, no deletion, PR required) is disabled. (ci-audit timings-flakiness#6)

4. **Delete `release.yml`.** Every day at 20:00 it creates a date-tagged release of the whole monorepo: 281 of them, with no assets, and nothing reads them. **Recommendation:** delete the workflow and `scripts/ci/create-release.ts`. Delete the date releases in a separate step, and never touch `gh-attach-assets`, which holds PR-body attachments. (ci-audit dumb-patterns#5)
5. **CI telemetry to PostHog: restore it or delete it.** Delivery has been zero since #2494, because CI events were more than 70% of PostHog ingestion ([`scripts/ci/posthog-events.ts:10-24`](../scripts/ci/posthog-events.ts#L10-L24)). About 1,470 lines still build events only to drop them: `sync-ci-telemetry.ts` 507, `test-telemetry-events.ts` 594, `review-telemetry.ts` 178, `telemetry-source-sync.ts` 135, plus their tests. `ci-telemetry.yml` now runs only on dispatch. **Recommendation:** delete the event builders and the workflow, and keep the raw artifacts, the finalizer and the flake records the dashboard reads. If analytics are needed later, sample from the artifacts: every failure and retry, plus 1% of passes. (scripts-ci#0, lost-ci#4, docs#18)
6. **Enforce or delete the lane/door/seam rule.** [`rules/terminology/no-metaphorical-lane-door-seam.md`](../rules/terminology/no-metaphorical-lane-door-seam.md) has severity error. Nothing has enforced it since the review bot went with #2837. About 540 lines of `.ts`/`.tsx` still match, down from about 750 before tonight's sweeps. #2953 renames the public SDK option `door` to `readSeed`. **Recommendation:** keep the rule and make it an oxlint rule, grandfathered like the test-style rules, so new code complies and old code converges. Deleting the rule would also be coherent; the current state, a rule nobody checks, is not. (docs#28, naming-homogeneity#24, os-tests#28, lost-lint-ts#9, prs-restores#17)
7. **Revisit two things you kept on purpose.**
   - **[`docs/preview-e2e-flake-hunt.md`](preview-e2e-flake-hunt.md)** (1,772 lines, restored by #2881). It logs the legacy slot fleet and has 15 dead references. Its only live use is as the evidence behind the retry policy. **Recommendation:** keep one evidence sentence in `docs/testing.md` and link the file at a permalink (`bd077e2e9~1`). (docs#13, lost-playwright#16, prs-restores#2)
   - **Five dormant lint rules** (#2897). Four guard subjects that no longer exist: oRPC procedures, `*-contract` packages, `ItxScriptBuilder` and an `env.ts` wrapper. The fifth, `mechanical-class-impl`, has two real sites. **Recommendation:** delete the four and arm the fifth. (lint-tooling#6, backcompat-sweep#10, prs-restores#25)
8. **Decide the SDK's and CLI's shape.** **Recommendation, in order.** Flatten `iterate/next/*` to `iterate/*`: about 265 import lines, and the "next" only told two platforms apart. Move the platform-only runtime out of the SDK ([A4](#a4-draw-the-sdkplatform-line)). Split the CLI and the menubar from the SDK, so app Workers stop depending on `@clack/prompts`, `@orpc/server` and `trpc-cli`. Rebuild the CLI's OAuth on the oauth4webapi flow the same package already ships ([`packages/iterate/src/cli.ts`](../packages/iterate/src/cli.ts) hand-rolls PKCE, registration, token exchange and refresh at :180–:433). Delete the menubar's dormant approval code ([X1](#9-dead-code-still-suspected)). All of these change the published surface, so do them after #2953 with one version bump. (sdk#8, naming-homogeneity#5, architecture#12, sdk#5, architecture#8)
9. **Rename `configs-next/` to `configs/`.** It is the last `-next` directory. Persisted template references pin a commit, so existing projects keep resolving. The rename touches `apps/os/scripts/build.ts`, the agents build, the docs and the workflow path filters. **Recommendation: yes, in one PR.** (naming-homogeneity#4, small-apps#16, agents#22)
10. **Decide on the agent history-rewrite guard.** [`.husky/prepare-commit-msg:13`](../.husky/prepare-commit-msg#L13) checks `CLAUDE_CODE`, but Claude Code sets `CLAUDECODE`, so the guard has never applied to it. Turning it on would also block `git rebase`, and `git pull` with `pull.rebase`, which the rebase-pr skill relies on. **Recommendation:** keep only the `--amend` block, and detect agents in one shared place: the hook, [`lint-staged.config.cjs:9-17`](../lint-staged.config.cjs#L9-L17) and [`packages/iterate/src/cli.ts:28-35`](../packages/iterate/src/cli.ts#L28-L35) each keep their own list. Or delete the hook. (lint-tooling#0, ci-audit local-vs-ci#8)
11. **Decide whether Preview OS gates merges.** Only "Lint and Typecheck" and "Test" are required. Preview OS is the only check that runs the platform deployed before a merge, and it is advisory. Since #2933, Main OS e2e reports after the merge. **Recommendation:** once the merge queue exists, add an always-running aggregate job to `preview-os-next.yml` that is green when no path matched, and require it. See [T1](#t1-decide-what-preview-os-e2e-must-prove).
12. **Make six small product calls.** My recommendation is in bold.
    - **Dark mode.** Every app forces light ([`packages/ui/src/apps/providers.tsx:15`](../packages/ui/src/apps/providers.tsx#L15)), yet packages/ui ships `next-themes`, a `.dark` palette and about 30 `dark:` classes. **Delete them.** (ui-shared#8)
    - **Kit analytics.** Kit is the only app without PostHog: `kitEnvs` has no key and there is no `/e/` proxy. **Add it, or write down why not.** (prs-clients#6, naming-homogeneity#9)
    - **Kit face/viseme polling.** The Waveshare AMOLED board calls `getProcessorRuntimeState` every 100 ms during answers, and nothing implements it ([`voice_stream.c:716`](../apps/kit/firmware/components/core/src/voice_stream.c#L716)). **Delete it.** (kit#2)
    - **Sprite pipeline** ([`apps/kit/tools/sprite-pipeline`](../apps/kit/tools/sprite-pipeline)). Its inputs are not committed, the rebuild gate its README names at :72 does not exist, and it emits atlas C a second way. **Delete it from this repo.** (kit#19)
    - **dummy-petshop's unused surfaces**: the WebSocket gateways, the GitHub App flow, webhooks, fault injection, `/rpc` and `/__backdoor/state`. Nothing outside the petshop calls them. **Delete them.** (small-apps#0)
    - **`ITERATE_KIT_DIAGNOSTIC_SILENT_OUTPUT`.** No target enables it, and it adds `#if` branches no test builds. **Delete it.** (kit#22)

## 1. Architecture

### A1. Take residency out of the context Durable Object

`IterateContextDurableObject` ([`apps/os/src/iterate-context-durable-object.ts`](../apps/os/src/iterate-context-durable-object.ts)) is 1,408 lines. About 200 of them are residency: the pins timer (:812–:848, :958), inbound-call counting and the residency watchdog (:963–:1062), and the unclaimed-facet sweep (:1063–:1126). About 110 are scheduled-append firing inside `alarm()` (:849–:957), about 235 the script runner (:454–:690) and about 185 the native fetch path (:1191–:1375). Seven public entries open with the same bookkeeping: an inbound-call count plus `appendWakeRecord("request")`. Tonight's #2943 already shares the work-in-flight sum and renamed the watchdog's decision to `decideQuietDeadline`.

**Direction.** Build a `context/residency.ts` class in the style of `AlarmCoordinator` and `FacetHost`. It owns both quiet clocks, the pins timer and the two deadlines, and the DO keeps one-line forwards. Then move scheduled-append firing next to `stream/scheduled-appends.ts`, and the fetch path into its own module, so the DO is wiring. (os-context#16, architecture#3) — **L · P2**

### A2. One account of the residency mechanisms

Seven mechanisms landed in one day, and each is explained only in its own file:

- the SDK's `withItx` recording of pipelined steps (#2846, removed by #2855, restored by #2863);
- the callee-side `itxAnswerDetachedFromSession` (#2855);
- `awaitAnswerReleasedIfRejected` in the walk (#2874);
- the log-only watchdog (#2858);
- the birth reset of unclaimed loaded facets (#2905);
- the quiet-period sweep (#2922);
- the 30-second pins timer.

No document says how they relate. The watchdog's `context.held-resident-while-idle` warn (:1046) is read by no alarm: [`scripts/ci/prd-fault-alarm.ts`](../scripts/ci/prd-fault-alarm.ts) pages on 5xx, on `platform-failure` heals and on errors.

**Direction.** Write one page in `apps/os/docs`, together with A1, and decide whether the watchdog pages or is deleted. (prs-platform#10) — **S · P2**

### A3. Put the SDK's tests and harness in the SDK

`stream/` is not oversized. It has 2,651 lines of production code (`stream.ts` 831, `subscription-delivery.ts` 996, `core-processor.ts` 665, `scheduled-appends.ts` 159), and the rest of its 9,100 lines is tests. But two of those test files test the SDK, not apps/os:

- [`processor.test.ts`](../apps/os/src/stream/processor.test.ts) (1,438 lines) and `processor-rules.test.ts` (595) test `ProcessorEngine` from `packages/iterate`, through `iterate/next/stream/processor`, and packages/iterate has no processor test of its own.
- apps/agents reaches across apps for the harness: [`apps/agents/runtime/processor.test.ts:8`](../apps/agents/runtime/processor.test.ts#L8) imports `../../os/src/stream/test-support.ts`, `voice/worker.test.ts:8` imports apps/os internals, and `voice/agent.test.ts:10` imports packages/iterate by path. So the "public SDK only" app's tests break when platform internals move.

**Direction.** Move both test files, and `reduceProcessor`, `memoryStream`, `memoryStorage` and `settle`, into packages/iterate, behind a `test-support` subpath. Node-SQLite Durable Object storage stays in apps/os. (os-stream#7, architecture#2, agents#21) — **M · P2**

### A4. Draw the SDK/platform line

Only apps/os imports `iterate/next/principal` and `iterate/next/expression`. The dispatch half of [`packages/iterate/src/next/expression.ts`](../packages/iterate/src/next/expression.ts) (from `registerPipelinedRpcBrand` at :289 to `materializeItxHandleReference` at :679: `walkSteps`, `callOn`, `installPrototypeInvokeFallback`, `walkStepsOnRpcStub`, `itxAnswerDetachedFromSession` and others) is platform runtime published as SDK API. So is most of `principal.ts` (`Caller`, `stampCaller`, claims). `stream/processor.ts` (1,154 lines) also holds the platform's core event envelope. #2953 narrows some exports but leaves the split as it is.

**Direction.** Move the dispatch runtime to `apps/os/src/context/dispatch.ts`, and the caller half of `principal.ts` into apps/os. The SDK keeps the codec, the handle types, `Principal` and the processor author surface. Split the envelope into `iterate/next/stream/event`. Pair this with decision 8. (sdk#17, architecture#4) — **L · P2**

### A5. One git protocol implementation

[`packages/shared/src/config-repo-template/git-wire.ts`](../packages/shared/src/config-repo-template/git-wire.ts) (675 lines) and [`apps/os/src/repo/git-wire.ts`](../apps/os/src/repo/git-wire.ts) (724 lines) are a fork: both export `pktLine`, `hashObject`, `parseTree`, `parseCommit`, `encodeCommit`, `parsePack`, `buildPack` and a transport. The shared copy's only consumer is its sibling `github.ts`, and apps/os is the only user of that (`session.ts:15`, `project/processor.ts:20`), so apps/os bundles two pack parsers. Its consumer uses only the fetch side, which leaves about half of the shared copy (encode and receive-pack) unused.

**Direction.** Move `github.ts` and `reference.ts` into `apps/os/src/project/`, point them at the apps/os codec, carry both test files over, and delete the shared copy (and `pako` from packages/shared if nothing else uses it). (ui-shared#2, prs-clients#13, backcompat-sweep#20, architecture#0) — **M · P2**

### A6. One entity lifecycle

The repo and workspace processors are near copies: [`repo/processor.ts`](../apps/os/src/repo/processor.ts) has 155 lines and `workspace/processor.ts` 159. They share the reduce, the sagas, the test rows and the `#created()` guard; the only real difference is the repo's `cfArtifacts.create/delete`. apps/agents re-declares the same creation and deletion schema field for field in `runtime/contract.ts`, and restates the collection's create/delete saga in `runtime/collection.ts`. It also writes the parent link at a different layer, under a different key.

**Direction.**

- Give repo and workspace one `runEntitySagas({ provision?, teardown? })` and one parameterised test table.
- Decide whether the lifecycle schema and a generic collection become SDK exports that userspace agents share. That would be an SDK addition.
- Two review-level API cleanups in the same area:
  - drop the repo's `readModules` ([`repo/durable-object.ts:67`](../apps/os/src/repo/durable-object.ts#L67), :191); only an e2e row calls it;
  - drop the workspace mount `{ repo }`, which always equals its own path ([`workspace/durable-object.ts:29`](../apps/os/src/workspace/durable-object.ts#L29), :142).

(os-entities#10, architecture#7, prs-platform#9, os-entities#8, prs-platform#12, os-entities#9) — **M · P2**

### A7. Build the Start-app skeleton once

dash, agents, notes, voice and kit repeat the same scaffolding:

- `src/server.ts`, 45–55 lines in each app; notes and voice differ only in the client name and one comment;
- `router.tsx`, identical in notes and voice;
- `routes/_auth.tsx`, identical in agents, notes and voice;
- `routes/__root.tsx`;
- the `Cloudflare.Env` declaration.

#2904 chose plain per-app files on purpose. Drift has started (only dash sets `viewport-fit=cover`), and #2936 had to fix the same `POSTHOG_PROJECT_KEY` cast in five roots.

apps/os is also a Start app, but it builds its Worker config through a separate template ([`wrangler.base.jsonc`](../apps/os/wrangler.base.jsonc) plus `scripts/generate-wrangler-config.ts`) rather than `startAppWorkerConfig`. #2953 moves it to `CLOUDFLARE_ENV`, and #2947 folded the three copies of "rm dist, then vite build" into one `viteBuild`.

**Direction.** Pick one of two:

- a test that asserts the files are identical apart from a named per-app constants block (cheap, and it keeps #2904's choice);
- factories in a workspace-private module: `startAppServerEntry({ clientName, signedInHome })`, one `Env` declaration file, `createAppRouter` and `AppDocument({ title })`.

Then express the OS Worker config as a typed function on the same base.

Also in this area:

- dash and notes carry the same `useProjectContext` hook, and six call sites pass the same liveSnapshot seed callback. Add `useProjectContext` and `useFacetLiveState` to `iterate/next/react` (small-apps#19).
- voice and kit import apps/agents source by relative path with no declared dependency: [`apps/voice/vite.config.ts:7`](../apps/voice/vite.config.ts#L7), `apps/voice/src/routes/_auth/projects.$slug.tsx:18`, and the same two lines in kit. Declare a workspace dependency, or move the voice installer into a small package (small-apps#22).
- Three deploy mechanisms coexist: `startAppCli`, petshop's `deployApp` with trpc-cli, and spa's hand-rolled deploy (small-apps#21, naming-homogeneity#28).

(dash#18, small-apps#20, prs-clients#7, naming-homogeneity#8, architecture#13, os-scripts#17, prs-restores#23) — **M · P2**

### A8. A per-request edge context

apps/os/src calls `platformAddressesOf(env, request)` at 15 sites and `new ControlPlane(env.CONTROL_PLANE)` at 13. The helpers take `(request, env, ctx, addresses?)` in varying orders.

**Direction.** Build one `EdgeRequest` value in `worker.fetch` and in the Start request context, and make `SessionInput` a projection of it. It is cross-cutting, so do it when the edge is next reworked. (os-issuer#22) — **L · P3**

### A9. Type the control plane's edge calls

`ControlPlane.#call(method: string, ...args: unknown[])` ([`control-plane/edge.ts:64`](../apps/os/src/control-plane/edge.ts#L64)) casts the stub to a string-keyed record and the result to a caller-chosen `T`, so a typo or a signature change still compiles. Reads also have three spellings across the catalog, the DO and the edge (`project` and `getProject`, `users` and `listUsers`).

**Direction.** Write each call as `#call((cp) => cp.project(ref))`, keep the retryable-stub replacement, and use one method vocabulary. (os-entities#5) — **S · P2**

### A10. The agent UI reducer should read today's events

packages/ui's [`agent-ui-reducer.ts`](../packages/ui/src/components/events/agent-ui-reducer.ts) (1,142 lines after tonight's #2946) still reads the legacy platform's `capability-host/script-run-*` events. apps/agents is its only consumer, and it translates every `context/run-requested` and `run-settled` into that shape ([`adaptContextRuns`, `apps/agents/src/lib/agent-events.ts:55`](../apps/agents/src/lib/agent-events.ts#L55)): it mints execution ids and pads failed settlements with fields the platform does not have. Bug [C1](#c1-interrupted-agent-runs-render-as-an-invalid-settlement) lives in that adapter. The agents page also opens a second live-state subscription for the `agent` facet ([`projects.$slug.tsx:286`](../apps/agents/src/routes/_auth/projects.$slug.tsx#L286)) that `useIterateContext` already holds. Removing it changes idle behaviour in prd, which is why it was not auto-merged.

**Direction.** Move the reducer into `apps/agents/src/lib`, fold `context/run-*` keyed by request offset, read the run deadline from the SDK's run contract, and delete the adapter. (agents#20, ui-shared#6, backcompat-sweep#15, naming-homogeneity#20, agents#2, prs-clients#9) — **L · P2**

### A11. Voice runs a second agent loop

`setupVoiceAgent` creates a normal agent and disables its processor ([`apps/agents/voice/worker.ts:163`](../apps/agents/voice/worker.ts#L163)). It then installs voice-delegate, whose [`delegation-turn.ts`](../apps/agents/voice/delegation-turn.ts) re-implements the loop with different rules:

- codemode feedback goes back as `user`, where the loop uses `developer`;
- steps are capped at 24 (`MAX_SCRIPT_STEPS`, :13) instead of the loop's budget;
- the model is called directly.

**Direction.** Let the context's normal `agent` processor answer delegations, through a thin adapter that appends the transcript and relays the summaries. (agents#19) — **L · P3**

### A12. Smaller structure items

Each is **P3**, S–M.

- apps/os/src has 45 top-level files. The secret feature alone spans `secrets.ts`, `secret-at-rest.ts`, `secret-oauth.ts`, `secret-oauth-callback.ts`, `secret/` and about 185 lines of `context/built-ins.ts`. Pure file moves would fix it (architecture#10).
- The first-party facets are declared in three tables ([`first-party-facets.ts:11`](../apps/os/src/first-party-facets.ts#L11), `context/facet-host.ts:87`, `context/first-party-facet-placement.ts:44`) plus the `worker.ts` exports. Derive them from one registry, and test the exports (os-context#17, architecture#14).
- packages/shared is mostly modules with a single consumer. Move each one next to its consumer, so the package becomes the PostHog proxy plus test support (ui-shared#19).
- `apps/os/scripts/preview.ts` is 1,096 lines, split by 9 section banners and with scattered `process.env` reads; split it along the banners (os-scripts#18). The operator's capnweb session is hand-rolled in `control-plane-load.ts` and `project-seed.ts`; give `iterate/next/node` a root-session dial (os-scripts#15).
- Bytes-to-hex and base64 are hand-rolled at four sites (os-entities#24). `context/cf-artifacts.ts:131` detects "not found" with `/not found|10200/`, although workers-types now ships `Artifacts` and `ArtifactsError.code`. Probe the deployed binding first (os-context#18).
- The static SPA and the browser extension carry two copies of the OAuth client (`apps/spa/public/oauth.js`, `apps/browser-extension/panel.js`), and capnweb is pinned three times, including a vendored 4,190-line `capnweb.js` (small-apps#23).
- Kit firmware: three boards hand-assemble the same avatar pipeline (kit#17), "one status language" has three renderers (kit#16), and the RLCD and NOTE4 boards are near-duplicate text-status boards (kit#23).
- A root vitest `projects` config could replace nine per-workspace test scripts that each spell out the long reporter path (lint-tooling#22).

## 2. Remaining backwards compatibility and migrations

#2950 removes the compatibility code that touches persisted or auth state:

- the issuer cookie scope override;
- `GrantProps.version`, in phase 1 of 2;
- the DO-birth subscription shim;
- the D1 replay and its operator id-pinning;
- the test-env credential overrides.

Its phase 2 (stop writing `version: 2`) needs a later deploy. From that deploy on, any build older than #2950 rejects new grants, so #2950 becomes the oldest safe rollback target. What remains:

### B1. CI trace tooling still models the deleted `preview-run.yml` pipeline

Only `preview-os-next.yml` is traced ([`scripts/ci/tracing/cli.ts:6`](../scripts/ci/tracing/cli.ts#L6)), yet the tooling still expects the old pipeline:

- `cli.ts:21-23` reads `CI_TRACE_GREEN*` markers that nothing sets;
- `tracing.ts:91` looks for a `:finish` job;
- `tracing.ts:596` strips the legacy reusable-workflow `preview:` job prefix;
- most of `tracing.test.ts` (1,449 lines) models that shape;
- [`docs/ci-traces.md:20`](ci-traces.md) says the assembler "still accepts" it.

**Direction.** Delete the legacy verdict path and fixtures, and keep today's Preview OS trace output byte for byte. (scripts-ci#1, lost-ci#0, docs#16, prs-restores#1, backcompat-sweep#3, naming-homogeneity#25) — **M · P2**

### B2. The flake dashboard carries the Worker-era design

The writer persists one `WriterState` artifact, but the fold still has the legacy stream processor's event-sourcing shape: URI-typed events, a birth event, and "the legacy `/flakes` stream offsets, continued" ([`scripts/ci/flake-dashboard/update.ts:55`](../scripts/ci/flake-dashboard/update.ts#L55)). It also accepts count-only "legacy" summaries (`contract.ts:178`; `tests` is optional in `packages/shared/src/test-support/flake-suite-summary.ts:13`).

**Direction.** Make the fold a plain `(state, run) => state`, compute proposals at render time, make `tests` required, and reset #2580's state once. The credential problem is separate and more urgent ([C3](#c3-live-ci-credentials-in-legacy-doppler-projects)). (scripts-ci#15, lost-ci#9, backcompat-sweep#7, prs-restores#24, ui-shared#11) — **M · P3**

### B3. Test-telemetry fields that nothing writes

[`packages/shared/src/test-support/ci-telemetry.ts`](../packages/shared/src/test-support/ci-telemetry.ts) keeps `DeploymentTelemetry` (:156, :206) and `expectedArtifactSources` (:197), and nothing produces either. Misha's completeness guarantee ("a process that never wrote even its pessimistic sentinel cannot silently disappear") depends on `expectedArtifactSources`, so it never fires. `docs/ci-test-telemetry.md` also requires versioned migrations for raw artifacts, which contradicts the repo's rule against backwards compatibility. (The ci-lint-tooling PR removes `previewSlot`.)

**Direction.**

- Have `preview.ts` declare the expected sources. That restores the guarantee, and it is cheap.
- Delete the deployment fields.
- Replace the migration rule with "raw artifacts live for one CI run; change them in place".

(ui-shared#10, lost-ci#5, docs#17, backcompat-sweep#22) — **M · P2**

### B4. do-reset still parks container classes and legacy migrations

[`scripts/lib/do-reset.ts`](../scripts/lib/do-reset.ts) (551 lines) first tries a "LEGACY migrations first" park (:369, form at :395), and keeps container classes. Its only caller passes `containerClassNames: []` (`apps/os/scripts/erase-data.ts:176`), and the OS Worker declares its Durable Objects through `exports`.

**Direction.** Reduce it to the exports-tombstone flow, and check the result with one preview erase. (scripts-ci#2, backcompat-sweep#4) — **M · P3**

### B5. Small leftovers in persisted state

Each is **S · P3** and needs one operator check first.

- [`apps/os/wrangler.base.jsonc:92`](../apps/os/wrangler.base.jsonc#L92) keeps the `AgentDurableObject` `deleted` tombstone. Delete it once every `osEnvs` deployment has shipped with it (os-scripts#24).
- [`apps/agents/voice/install.ts:5`](../apps/agents/voice/install.ts#L5) and :53 keep the `kit/voice/` KV prefix and the `kit/install/` key "so installed projects keep their keys". The keys are content-addressed and never re-read, so new installs can use `voice/` (agents#14, backcompat-sweep#8).
- [`apps/kit/src/device-auth.ts:73-74`](../apps/kit/src/device-auth.ts#L73-L74) redirects `/.auth/login` for "old bookmarks". Decide whether that is a rule (keep it and reword the comment) or a shim (delete it) (backcompat-sweep#21).
- `apps/notes/src/routes/_auth/projects.$slug.tsx:82` and :134 treat `creation: null` as ready, "for a project born before the saga". Confirm prd has no such project, then make `creation` required (small-apps#8).
- [`apps/os/src/stream/stream.ts:154`](../apps/os/src/stream/stream.ts#L154) rebuilds a missing core checkpoint for "a store from before the SQL layout", which this code never wrote. Delete the narration now, and decide whether corruption should throw rather than heal itself (os-stream#11).
- [`apps/os/src/app-config.ts:173-174`](../apps/os/src/app-config.ts#L173-L174) narrows `ingressRouting` by hand, and :208 walks the schema to warn about unknown keys. The rein-in plan wanted a discriminated union and `.strict()`. Check every Doppler `APP_CONFIG` blob first (prs-platform#13).

## 3. Security and correctness follow-ups

### C1. Interrupted agent runs render as an invalid settlement

When a restart cuts a run off, the platform settles it with `failureKind: "interrupted"` ([`apps/os/src/stream/stream.ts:234-239`](../apps/os/src/stream/stream.ts#L234-L239); the SDK allows it in [`iterate/next/stream/run.ts:19`](../packages/iterate/src/next/stream/run.ts#L19)). apps/agents spreads that settlement into the legacy shape ([`agent-events.ts:88-96`](../apps/agents/src/lib/agent-events.ts#L88-L96)). The reducer then validates it against [`packages/shared/src/script-execution.ts:11`](../packages/shared/src/script-execution.ts#L11), whose `failureKind` enum has no `interrupted`, so `readCodeOutcome` (`agent-ui-reducer.ts:1067-1074`) shows "The durable script settlement is invalid." for every interrupted run.

**Direction.** Parse with the SDK's `RunSettled`, or add `interrupted` to the enum, and add a reducer row for it. The lasting fix is A10. (prs-clients#0) — **S · P1**

### C2. A caller can choose a new agent's parent link

`AgentCollectionRpcTarget.create(path, { creator })` ([`apps/agents/runtime/collection.ts:59-63`](../apps/agents/runtime/collection.ts#L59-L63)) takes `creator` from the caller and writes `itx.cd(<creator>)` as the child's `itx` rewrite rule (:94). A script that holds a scoped `itx.agents` can pass `{ creator: "/" }`, and the new agent's `itx` resolves at the project root, wider than the caller's own. The platform derives the creator from the caller instead ([`apps/os/src/library.ts:455`](../apps/os/src/library.ts#L455)), and nothing passes the option.

**Direction.** Drop the parameter and use `this.base`. It changes a userspace API, which is why it was not auto-merged. (agents#10) — **S · P1**

### C3. Live CI credentials in legacy Doppler projects

[`.depot/workflows/flake-dashboard.yml:51-52`](../.depot/workflows/flake-dashboard.yml#L51-L52) reads the GitHub App id and private key from the Doppler project `os-legacy-backup`, and nothing else in the repo refers to that project. Anyone tidying Doppler after the legacy removal would delete it, and #2580 would stop updating. The DO duration alarm reads yet another project, `os` ([`scripts/ci/do-duration-alert.ts:177`](../scripts/ci/do-duration-alert.ts#L177)), although `envs.ts` declares `_shared` for account-wide tooling, and the Test workflow reads `test`. Doppler also holds 16 projects that nothing in this repo reads (among them `auth`, `semaphore`, `tunnels` and `streams-example-app`); some may serve other repos.

**Direction.**

1. Copy the two GitHub App secrets to `_shared/prd`, and pin the project name in the workflow test.
2. Point the alarm at `envs.ts` `cloudflareAccounts`.
3. Only then list what each Doppler project is read by, and delete the rest.

(lost-ci#10, scripts-ci#5) — **S · P1**

### C4. Self-hosting cannot create a project

The self-host config binds the Artifacts namespace `iterate-repos` ([`apps/os/scripts/generate-wrangler-config.ts:170`](../apps/os/scripts/generate-wrangler-config.ts#L170)). A repo create on a namespace that does not exist fails with "Namespace is not active" (`wrangler.base.jsonc:55`; this is why `preview.ts:273` creates one for each preview). Neither `SELF-HOSTING.md`, nor the served `setup-prompt.md`, nor `ensure-resources.ts` creates it, and every project's birth creates `/repos/config`. Not reproduced on a fresh self-host.

**Direction.** Share `ensureArtifactsNamespace` with `ensure-resources.ts`, and add the step to both docs. (os-scripts#1) — **M · P2**

### C5. An append whose reply is larger than the RPC cap

Three rows in [`apps/os/src/stream/memory-budget.test.ts`](../apps/os/src/stream/memory-budget.test.ts) pin known bugs with `test.fails`, and none has an issue or an owner:

- :171: a committed batch whose echoed reply serializes to more than 32 MiB returns an RPC error for a batch that is already in the log, and a retry without an idempotency key appends it twice;
- :417 and :433: byte budgets cannot see parsed cost. Two 4 MiB object-dense events exhaust memory on one page, and in the constructor's re-reduce that is a reboot loop.

**Direction.** Decide whether `append` returns receipts (`{ offset, createdAt }`) instead of full events. That is an API change, and it removes the echo bug. File the two memory rows as issues. (os-stream#13) — **M · P2**

### C6. The self-loop hop budget gap

[`apps/os/e2e/ingress-project-host.e2e.test.ts:220-228`](../apps/os/e2e/ingress-project-host.e2e.test.ts#L220-L228) is an opt-in `test.fails` row. An app that fetches its own host with a fresh `Request` re-enters at hop 1 every pass, so the edge's hop budget never bounds it. No workflow runs the row, and two other opt-in probes are in the same state.

**Direction.** Fix the gap, or accept the limit and write it down. Then schedule or delete the probes. (os-tests#27) — **S · P2** (the decision)

### C7. Workarounds that heal a platform fault without saying so

[`docs/engineering-invariants.md`](engineering-invariants.md) requires every workaround that heals a platform fault to log a `<area>.platform-failure-<action>` warn, and the prd fault alarm pages on bursts of them. Only one site emits it ([`context/facet-host.ts:594`](../apps/os/src/context/facet-host.ts#L594)). The loader-generation bump for isolates whose startup failed ([`context/worker-loader.ts:76`](../apps/os/src/context/worker-loader.ts#L76)) heals without it.

**Direction.** Add `loader.platform-failure-new-generation`, and classify the fetch path's `request-body-unread` warn explicitly. (prs-platform#5) — **S · P2**

### C8. Organization and account folds can drift from the catalog

The control-plane SQLite catalog is the truth. The facts the dash renders from are posted afterwards, in `waitUntil`, with no retry. #2950 stops dropping failures silently, but nothing reconciles a lost or reordered fact, so the dash's organization tree can stay wrong.

**Direction.** Add an outbox to `ControlPlaneDurableObject`: write pending facts in the same transaction as the row, and deliver them from its alarm until they are acknowledged. The alternative is to render the tree from a live catalog read. (architecture#6) — **M · P2**

### C9. erase-data may not empty R2

[`apps/os/scripts/erase-data.ts:76-77`](../apps/os/scripts/erase-data.ts#L76-L77) empties the files bucket with one bulk `DELETE /r2/buckets/<bucket>/objects`. Only its own test's mock backs that endpoint; `preview.ts` deletes object by object, and that path has been measured against the real API. (unverified: whether Cloudflare accepts the bulk call.)

**Direction.** One shared, measured routine for emptying Artifacts namespaces and R2 buckets, used by both scripts. (os-scripts#16) — **S · P2**

### C10. Preview dashes link to the production apps

[`apps/dash/src/apps.ts:4-21`](../apps/dash/src/apps.ts#L4-L21) is a literal list of prd URLs, so a PR preview's dash sends you to prd agents, notes and voice, where the preview's project does not exist. (#2936 fixed the stale Voice URL.)

**Direction.** Pass the app origins in as Worker vars from `envs.ts`, overridden per PR by `preview-config`. (dash#1, prs-restores#19) — **M · P3**

## 4. Test architecture

There are four layers, as `docs/testing.md` describes them:

- **unit**: node;
- **workers**: vitest-pool-workers, inside workerd;
- **e2e**: vitest against a deployed or local OS (`WORKER_BASE_URL`);
- **specs**: Playwright, in the root `specs/`.

Preview OS runs e2e and specs against a per-PR preview. Main OS e2e runs the same after each merge and pages on a state change. Coverage of the platform is strong. The gaps are at the edges and in how the layers share code.

### T1. Decide what Preview OS e2e must prove

It is the only pre-merge check that runs the platform deployed, and it is not required (decision 11). Write down its charter: which classes of bug must be caught there (deployed-runtime behaviour such as Durable Object eviction and hibernation, Artifacts, OAuth across hosts) and which belong in the workers and unit layers. Then decide whether it gates merges. Without a charter, every flaky or slow row is argued case by case. — **S · P2**

### T2. Test the SDK's API through its types

The e2e harness is untyped: [`apps/os/e2e/support/client.ts:143`](../apps/os/e2e/support/client.ts#L143) has `session(): any`, :177 has `openItx(): any`, and apps/os/e2e has about 137 `any`s. So e2e never proves the SDK's typed API. The public `iterate/next/*` types have no `expectTypeOf` tests either; the repo's only type-test file is lint's.

**Direction.** Type the harness with `IterateApi` and `IterateContextApi`, build `openItx` on the SDK's node dial, and add type tests for the processor, live-state and React hook surfaces. (architecture#11, lost-lint-ts#14) — **M · P2**

### T3. One test-support layer, and one home per property

Each layer re-implements the same helpers:

- two `until`s with different semantics: [`e2e/support/client.ts:294`](../apps/os/e2e/support/client.ts#L294) swallows throws and waits 20 s, while `__workers-tests__/support.ts:213` propagates them and waits 10 s;
- three `cloudflare:workers` Node shims, in apps/os, dummy-petshop and packages/iterate;
- password sign-in, written three ways;
- several fixture-naming schemes.

Several e2e properties are also proven in two to four files: delivery stop, stub lifetimes, the Artifacts round trip, and shadowing a built-in root.

**Direction.** Put the pure helpers in one runtime-neutral test-support module, keep only the transport in each layer, and pick one home per property. (os-tests#30, lost-playwright#7, naming-homogeneity#22, os-tests#18, os-tests#9) — **M · P3**

### T4. One pinned-bug convention

[`docs/testing.md:631`](testing.md) says to pin known bugs with `createFailing`, not bare `test.fails`, but the code does the opposite. apps/os has 26 bare `test.fails` lines, and nothing outside its own package calls `createFailing`. [`memory-budget.test.ts:8`](../apps/os/src/stream/memory-budget.test.ts#L8) even calls bare `test.fails` "the house convention". Only the three monthly sentinels use `createFlake`, and they hard-code `2026-10-01` (the ci-lint-tooling PR takes that).

**Direction.** Pick one convention. I recommend `createFailing`, because it goes red when the pinned failure changes. Convert the rows and link each to an issue (C5). Then extract the registration machinery that `createFlake` and `createFailing` duplicate. (lost-playwright#1, ui-shared#18) — **S · P2**

### T5. Browser specs for Dash and Agents

[`playwright.config.ts:73-104`](../playwright.config.ts#L73-L104) has the projects `os`, `os-phone`, `notes`, `voice` and `suite`. The dash has about 4,000 lines and no tests. Only `specs/notes/sessions.spec.ts` reaches it, and seven of its test ids have no reader, among them `minted-token` ([`apps/dash/src/routes/_auth/sessions.tsx:244`](../apps/dash/src/routes/_auth/sessions.tsx#L244)); the PAT spec was deleted when the dash moved out. Agents had the richest spec coverage before #2837 and has none now. Since #2929, `createFixture(prefix, { app })` makes each of them a folder plus a project entry. For Agents, use a `provide("itx.ai", fake)` shadow instead of the deleted AI interception. (dash#11, lost-playwright#19) — **M · P2**

### T6. Give the spec harness its operator handle back

The legacy fixture offered `fixture.itx`. Without it, four places hand-roll admin capnweb sessions ([`specs/os/auth.spec.ts:75`](../specs/os/auth.spec.ts#L75), :258, `specs/os/mini-app.spec.ts:44` and `specs/notes/sessions.spec.ts:82`), and two password sign-in helpers are identical (`auth.spec.ts:293`, `issuer-pages.spec.ts:229`).

**Direction.** Add `openOperatorSession(baseUrl)` and `signInWithPassword` to `specs/test-support`. (lost-playwright#3, lint-tooling#17) — **S · P3**

### T7. Budgets, retries and flakes

- **Budgets.** [`packages/shared/src/test-support/e2e-policy/budgets.ts`](../packages/shared/src/test-support/e2e-policy/budgets.ts) still exports constants for lanes that no longer exist, and `apps/os/vitest.config.ts:102-150` hard-codes its own timeouts and `retry`. The ci-lint-tooling PR trims the file and wires the retry to `E2E_CI_RETRIES`. After it lands, check the ladder in `docs/testing.md` against `budgets.ts` in a test. That brings back the invariant test lost with #2837.
- **Retries.** One retry in CI and none locally, recorded by the retry-telemetry reporter. That is sound; keep it.
- **Flakes.** #2580 lists about 25 preview-e2e rows, and all of them failed once on `2eb7238e` with a workerd `internal error; reference = …` and passed on the next commit. That was one blip across the whole preview, not 25 flakes, and the rows clear at 20 consecutive passes (8 of 20 now). The dashboard should recognise a run in which many rows fail with the same infrastructure error. The real flake is "a project host verifies an OAuth bearer, strips credentials and rejects a grant for another project" (`Choose at least one project you can access.`, 12 of 20 passes since); diagnose it. The `internal error` references can be looked up in Workers Logs for preview `main-2eb7238` if you want the blip explained.
- **Test-file nits.** `apps/os/__workers-tests__/control-plane-contexts.test.ts` wraps rows in describes labelled "(passing)" (:34, :84), keeps an in-memory reducer test in the workers layer, and has two empty `test.skip` placeholders (os-tests#31).

## 5. CI and tooling

Done tonight:

- main deploys in under a minute with no residency wait (#2933);
- deploys trigger on what they ship and notify inside the deploy job (#2941);
- scheduled jobs stop painting main red, and autofix and the telemetry cron are gone (#2938);
- the flake dashboard runs hourly (#2938);
- one lint definition, `lint:fix` single-threaded, `pnpm test` without cmake, and a portable PR-guidance hook (#2940);
- Deploy Kit went from 449 s to 41 s (#2948).

In flight: knip on every workspace, every TS file typechecked, a past cutoff for `no-shouting-constants`, and `typed-no-floating-promises` armed. What remains:

### I1. The merge queue

See decision 3. **P1**

### I2. Replace blame-based grandfathering with a checked-in baseline

[`lint/grandfather-rule.ts:62-123`](../lint/grandfather-rule.ts#L62-L123) runs `git ls-tree` and `git blame` for every file that has a reported violation: about 224 files and 448 git spawns per run. That costs three things:

- CI lint has to clone the full history ([`.depot/workflows/lint-typecheck.yml:32`](../.depot/workflows/lint-typecheck.yml#L32), `fetch-depth: 0`);
- local lint took 233 s and then crashed with `ETIMEDOUT` on a blobless clone;
- a date cutoff turns main red when a PR's branch commits predate the cutoff and its squash commit does not (#2935, fixed by #2942, tonight).

**Direction.**

- Generate `lint/grandfathered.json`: file → rule → hash of the line text → count.
- Have `grandfatherRule` read that file instead of git.
- Add `pnpm lint:prune-baseline`, which can only remove entries, and a test that fails on stale ones.
- Drop `fetch-depth: 0`.

The baseline also makes the burn-down in I3 visible. (ci-audit local-vs-ci#4, dumb-patterns#15) — **M · P2**

**For your machine.** The main checkout here is a blobless partial clone. Lazy blob fetches from blame and `git log -S` piled up thousands of packs. One-time fix, to run when no agent is using the checkout (about 105 MB; tested on a copy): `git config --unset remote.origin.partialclonefilter && git config remote.origin.promisor false && git fetch --refetch origin && git gc`. (ci-audit local-vs-ci#5)

### I3. Burn down the grandfathered lint debt

Measured before tonight: 1,846 grandfathered lines, 1,224 of them in apps/os.

| Rule                                                 | Lines |
| ---------------------------------------------------- | ----: |
| prefer-object-property-match                         | 1,047 |
| helpers-after-tests                                  |   243 |
| no-describe                                          |   185 |
| simple-truthiness-check (64 in the agent UI reducer) |   145 |
| prefer-test-over-it                                  |   126 |
| no-lifecycle-hooks                                   |    44 |
| no-shouting-constants                                |    42 |
| no-vi-mock                                           |    14 |

**Direction.** One rule per PR, the mechanical ones first (prefer-test-over-it and no-describe are codemods). When a rule reaches zero, replace its grandfather wrapper with the plain rule. The ci-lint-tooling PR takes some of the mechanical ones. (lost-lint-ts#13, lost-playwright#18) — **L · P3**

### I4. Alarm workflows on the vanilla runner

Apart from the image bake, [`prd-fault-alarm.yml:25-38`](../.depot/workflows/prd-fault-alarm.yml#L25-L38) and `do-duration-probe.yml:59-78` are the only workflows on `depot-ubuntu-24.04`. Each run does a `pnpm install` and `curl https://cli.doppler.com/install.sh | sh`: about 120 runs a day, on the pager path.

**Direction.** Use the baked image, `dependencies.mjs install` and a 10-minute timeout, and add a workflow test that every job except the bake uses the image. (ci-audit dumb-patterns#16) — **S · P3**

### I5. Main gets no trace and no Playwright report, and the report viewer is gone

[`main-os-e2e.yml`](../.depot/workflows/main-os-e2e.yml) (265 lines) repeats `preview-os-next.yml`'s e2e job, but uploads only flake records and telemetry (:186–:212). It keeps no Playwright report, and it is not traced. #2658 made main and PRs share one reusable workflow to avoid exactly this.

Separately, the viewer that opened CI traces and Playwright HTML reports in one click (#2681, #2690) lived in the external iterate/config project and went with #2837. Both are download-only now, and the `public-` artifact prefix no longer means anything.

**Direction.** Extract the e2e and trace jobs into one `workflow_call` workflow that both callers use. Decide whether to rebuild the viewer: it was ZIP range reads from Depot, one origin per artifact, which fits a small Worker. (lost-ci#3, lost-ci#2) — **M · P2**

### I6. Preview work selection

#2712 chose what to run from the changed files, and gave a docs-only commit its settled ancestor's result. Today the only selection is the `paths:` list ([`preview-os-next.yml:48-75`](../.depot/workflows/preview-os-next.yml#L48-L75)), which matches the markdown under apps/os, specs and packages, so a README edit deploys every app and runs the full e2e. The `apps=auto` mode (`preview.ts:80`, `changedPaths` at :465) can only be reached by manual dispatch.

**Direction.** Restore the cheap half of #2712 (skip deploy and e2e when every changed path is `*.md`), or delete `auto`. (lost-ci#11) — **S · P3**

### I7. apps/os has no route-tree check

Every other Start app runs `routes:check` in `typecheck`. [`apps/os/package.json:10`](../apps/os/package.json#L10) does not, although it commits `src/routeTree.gen.ts`, which its Vite build quietly regenerates. The shared generator needs the `startInstance` import first. (prs-clients#17, ci-audit local-vs-ci#9) — **S · P3**

### I8. Dependency drift and the zod patch

The lockfile resolves four vitest versions: 4.0.15 (pinned in packages/iterate and dummy-petshop), 4.1.5, 4.1.8 and 4.1.10. Every workspace loads the same retry reporter, which declares structural types to cope with that. zod is exactly `4.5.4` in seven package.json files and `^4.1.5` in six. The RPC fix in `patches/zod@4.5.4.patch` applies only to 4.5.4 exactly ([`pnpm-workspace.yaml:82`](../pnpm-workspace.yaml#L82)), so a caret range that moves drops the patch without a sign.

**Direction.** Add a catalog next to `catalogs.cloudflare` with `zod: 4.5.4` and one vitest version, and move petshop and packages/iterate to 4.1.x. (small-apps#11, lint-tooling#13, ui-shared#20, naming-homogeneity#21) — **S · P2**

### I9. Lint and TypeScript configuration drift

Each is **S · P3**.

- `import/extensions` ([`.oxlintrc.json:191`](../.oxlintrc.json#L191)) and `iterate/relative-import-extensions` (:120) report the same missing extension twice. Keep the file-aware one, which has an autofix, after checking it covers `.tsx` (lint-tooling#8, lost-lint-ts#11).
- `verbatimModuleSyntax` and `erasableSyntaxOnly` are on in the packages but not in `tsconfig.base.json`. Before tonight, turning both on failed only on parameter properties (TS1294), in apps/os and apps/agents (lint-tooling#19).
- knip treats the export maps of packages/shared and packages/ui as public entry points ([`knip.ts:55`](../knip.ts#L55), :77), so it never reports their unused exports, although both packages are private. `includeEntryExports: true` surfaces about 150. Clean them up in the same PR (ui-shared#14).
- `iterate/isolated-codemode`, `unicorn-js/isolated-functions` and `codegen/codegen` are armed with nothing to check (`.oxlintrc.json:134`, :146, :199) (lost-lint-ts#4).

### I10. scripts/ci consistency

Each is **P3**, S–M.

- There are four CLI entry styles (trpc-cli, hand-rolled argv, a switch on `argv[2]`, flag helpers) and several main-module checks. Standardise on `isMainModule` plus trpc-cli (scripts-ci#13).
- Workflow-shape tests are spread over four files, with four YAML loaders. Use one helper and one file (scripts-ci#22).
- Four scripts use Slack channel history as their only state, each with a different query, and only one paginates. Add one `findLatestBotMessage` to `slack.ts` (scripts-ci#23).
- "Our own zones" is derived twice: `ownZones()` in [`scripts/lib/start-app.ts:62`](../scripts/lib/start-app.ts#L62) and `ownZonesOf()` in apps/os (scripts-ci#9).
- Six client deploy workflows rely on the `DOPPLER_CONFIG` fallback instead of passing `--env prd`. #2947 dropped the change because it edits workflow YAML (scripts-ci#10).

### I11. Kit firmware CI

Each is **S · P3**.

- The host build fetches capnweb with `GIT_SHALLOW FALSE` on every run ([`apps/kit/firmware/CMakeLists.txt:28`](../apps/kit/firmware/CMakeLists.txt#L28)). Pin it shallow, to the commit.
- The board sends `X-Iterate-Fw` (`itx_transport.c:697`), and nothing on the server reads it. Log it on upgrades.
- Kit Firmware is not a required check. The design recommends keeping it that way until a broken board build merges.

## 6. Naming and homogeneity

### N1. "OS Next" and `-next`

About 350 lines still match os-next, OS Next, osNext or OS_NEXT. They fall into four groups:

1. **Internal** comments, identifiers and temp-dir names, plus the Depot workflow file names and concurrency groups (`deploy-os-next.yml`, `preview-os-next.yml`, …). The internal rename PR takes these; it runs last, and required check names do not change.
2. **Public surface.** #2953 takes `connectOsNext`, the CLI copy, `OS_NEXT_ENV` and `OS_NEXT_DEV_PORT`. `iterate/next/*` is decision 8, and `configs-next/` is decision 9.
3. **Deployed names.** Decision 2.
4. **PR-body markers** (`<!-- os-next-preview:begin -->`). They are a persisted format in open PR bodies: either keep them, or accept one duplicated section per open PR.

(naming-homogeneity#2, backcompat-sweep#16, docs#12) — **P3**

### N2. One name per test target and per credential

The OS under test has three names:

- `DEMO_BASE_URL` and `DEMO_PORT` for Playwright ([`playwright.config.ts:14-15`](../playwright.config.ts#L14-L15), `specs/setup.ts:39`). "DEMO" is left over from the video-demo harness.
- `WORKER_BASE_URL` for vitest e2e.
- `OS_BASE_URL`, derived inside the specs.

`apps/os/scripts/preview.ts:742` sets two of them to the same value.

The admin bearer also has three names:

- `ADMIN_API_SECRET`: the e2e harness's internal channel and the apps/agents scripts.
- `APP_CONFIG_ADMIN_API_SECRET`: the CLI ([`packages/iterate/src/cli.ts:139`](../packages/iterate/src/cli.ts#L139)). It looks like an `APP_CONFIG` override, but the real override is `APP_CONFIG_SECRETS__ADMIN_BEARER`.
- `secrets.adminBearer`: the Worker.

The voice README tells operators to read a Doppler key under the second name, and that key does not exist ([`apps/agents/voice/README.md:83`](../apps/agents/voice/README.md#L83), `apps/agents/scripts/voice-call.ts:12`).

**Direction.** Use `OS_BASE_URL` for both runners and one bearer name for every client-side consumer. These are env var renames, so they need review. (lint-tooling#18, docs#10, lost-playwright#11, prs-restores#22, naming-homogeneity#14, docs#9, os-scripts#14, naming-homogeneity#15) — **S · P2**

### N3. The MCP server calls itself "control-plane"

[`apps/os/src/mcp.ts:102`](../apps/os/src/mcp.ts#L102) sets the name to `control-plane`, and MCP clients show it to people. Since #2888, "control plane" in this codebase means the catalog DO. Rename it to `iterate`. (prs-platform#14) — **S · P3**

### N4. envs.ts has three shapes for one app env

`KitEnv` ([`envs.ts:34`](../envs.ts#L34)) and `DummyPetshopEnv` (:275) are the same interface. `scripts/lib/start-app.ts:29` declares a third, `StartAppEnv`, and the dash, agents, notes, voice and spa maps are untyped. Use one `AppEnv` and have `OsEnv` extend it. (naming-homogeneity#13) — **S · P3**

### N5. PostHog is three integrations

- packages/ui's browser setup (dash, agents, notes, voice);
- a separate inline `posthog-js` init with different options on the issuer pages ([`apps/os/src/routes/__root.tsx:33-37`](../apps/os/src/routes/__root.tsx#L33-L37));
- `posthog-node` on the issuer server (`apps/os/src/posthog.ts:23`).

**Direction.** Put one DOM-free options builder and the host constants in `packages/shared/src/posthog`, and use them in all three. (prs-clients#3) — **M · P3**

### N6. packages/ui imports

Some files import siblings through `@iterate-com/ui/...` and others relatively. The self-imports rely on a `paths` mapping in [`packages/ui/tsconfig.json:14-17`](../packages/ui/tsconfig.json#L14-L17) that no other workspace has. Twenty files start with `"use client"`, in apps that have no React Server Components. It is a mechanical PR. (ui-shared#15) — **S · P3**

## 7. Docs

### D1. Restored docs still narrate the deletion

`docs/*.md` still has 27 lines that say what "went with #2837" or what "the legacy platform" did: 11 in `testing.md`, 9 in `dev-environments.md`, 3 in `depot-ci.md`, and the rest elsewhere. Two docs are mostly about the deleted pipeline:

- [`docs/ci-traces.md`](ci-traces.md) (189 lines) says most of its sections describe the legacy pipeline.
- [`docs/ci-test-telemetry.md`](ci-test-telemetry.md) (877 lines) documents the deleted orchestrator's lanes and fields, and has about 170 lines of case studies about deleted code.

The docs-sweep PR corrects facts; this is the cut that should follow it.

**Direction.** Rewrite to today's system, keeping each lesson without its provenance. Cut `ci-test-telemetry.md` to the artifact contract, the finalizer, flake records and the unknown-flake rules. Cut `ci-traces.md` together with B1. (prs-restores#0, backcompat-sweep#19, docs#17) — **M · P2**

### D2. docs/pull-requests.md waits for a bot that no longer exists

[`docs/pull-requests.md:102-110`](pull-requests.md) tells agents to wait for "Iterate Review", which, as the doc itself says, has not posted since #2837. Line 78 accepts pkg.pr.new builds of middlewright and says publishing to npm will be done manually later (see section 8). Fix these together with decision 6. — **S · P3**

### D3. The rein-in plan's open rows

#2837 deleted `tasks/2026-09-22-os-next-rein-in.md` while some rows were still open: `readModules`, app-config row 9, the dash's `apps.ts`, the duplicated scripts helpers. The DO shim among them is now in #2950. Diff the plan against main (`git show bd077e2e~1:tasks/2026-09-22-os-next-rein-in.md`) and file what is left as one issue. (prs-restores#18) — **S · P3**

### D4. Small stale references

- `apps/kit/tools/sprite-pipeline/README.md:72` names a test that does not exist. This is moot if the pipeline goes (decision 12).
- [`apps/os/src/client/presence/durable-object.ts:3`](../apps/os/src/client/presence/durable-object.ts#L3) and `processor.ts:3` cite a `build-sdk.mjs` that does not exist; `scripts/build.ts:42` does the bundling.
- `M1` in `stream/core-processor.ts`, and some of the 27 `rule N` citations in apps/os/src, point at numbered lists that were deleted (the notes from #2937). Sort the live ones from the dead ones.

## 8. Misha's investments

Short answer: the baby is mostly still here. #2864–#2932 restored most of it. Five things are actually lost: the report viewer, preview work selection, main-branch traces and Playwright evidence, the review bot that enforced `rules/**`, and the spec harness's operator handle. Several things are present but not doing their job: `createFailing` has no caller, the telemetry completeness guarantee has no writer, and knip covers 5 of 13 workspaces (being fixed).

| Investment                                                                                                                                       | Now                                                                                                                                                                                 | Recommendation                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iterate oxlint plugin and custom rules                                                                                                           | **Restored** (#2897); `oxlint . --deny-warnings` is clean                                                                                                                           | Keep                                                                                                                                                                                    |
| `grandfatherRule` (date cutoff through git blame)                                                                                                | **Present, costly**: full-history clones, slow local lint, tonight's red main                                                                                                       | Keep the idea; replace blame with a baseline file (I2)                                                                                                                                  |
| Six test-style rules                                                                                                                             | **Restored**; about 1,650 lines grandfathered; tonight's PRs removed the redundant `vi.mock("cloudflare:workers")` calls                                                            | Burn down one rule per PR (I3)                                                                                                                                                          |
| `no-shouting-constants`                                                                                                                          | **Degraded**: its cutoff is 2026-11-10, so CI enforces nothing                                                                                                                      | Past cutoff in flight (checks-cover-everything)                                                                                                                                         |
| Type-aware lint (tsgo service, `simple-truthiness-check`)                                                                                        | **Present**                                                                                                                                                                         | `typed-no-floating-promises` has never been armed ([`.oxlintrc.json:130`](../.oxlintrc.json#L130)). Two type-aware rules need one shared file snapshot, or the plugin errors. In flight |
| Dormant rules kept by #2897                                                                                                                      | **Present, unarmed**                                                                                                                                                                | Decision 7                                                                                                                                                                              |
| Dated-skip and scope-liveness guards                                                                                                             | **Present**                                                                                                                                                                         | Keep                                                                                                                                                                                    |
| Type coverage and type tests                                                                                                                     | **Degraded, partly restored**: #2944 brought packages/shared tests back into typecheck; the SDK's `src/next` tests are still outside every program                                  | Rest in flight; add `expectTypeOf` tests for the public SDK (T2)                                                                                                                        |
| knip                                                                                                                                             | **Degraded**: 5 of 13 workspaces; the root spec suite is not covered; the export maps hide unused exports                                                                           | Widening in flight; `includeEntryExports` (I9)                                                                                                                                          |
| Strict agent pre-commit (lint-staged, #2932)                                                                                                     | **Restored**, and runnable since #2940                                                                                                                                              | Keep                                                                                                                                                                                    |
| History-rewrite guard (`prepare-commit-msg`)                                                                                                     | **Never active** under Claude Code                                                                                                                                                  | Decision 10                                                                                                                                                                             |
| `rules/**/*.md` and the Iterate Review bot                                                                                                       | **Bot legitimately gone** with the legacy platform; the rules have no enforcer                                                                                                      | **Should return**, as oxlint rules for the mechanical ones (decision 6)                                                                                                                 |
| Playwright spec harness (root `specs/`, one project per app, `createFixture({ app })`)                                                           | **Restored** (#2895, #2927, #2929); **degraded**: no operator handle, no Dash or Agents project                                                                                     | T6, T5                                                                                                                                                                                  |
| middlewright (hydration waiter, UI-error reporter, spinner waiter, 1 s action budget, three lint rules)                                          | **Present**; pinned to a pkg.pr.new build ([`package.json:42`](../package.json#L42)), although Misha moved it to registry releases twice (#1575, #2492)                             | Publish 0.1.7 from `e3f2374` and pin it (lost-playwright#13)                                                                                                                            |
| Video mode (`VIDEO_MODE`, `PLAYWRIGHT_SCREENSHOT`)                                                                                               | **Present** (checked by reading the wiring; not run end to end)                                                                                                                     | Record one demo against a preview to prove it                                                                                                                                           |
| AI interception (`intercepted/*`, the resilient interceptor)                                                                                     | **Legitimately gone**: it served the legacy and mobile specs                                                                                                                        | Use a `provide("itx.ai", fake)` shadow                                                                                                                                                  |
| `createFlake`, `createFailing` and the sentinels                                                                                                 | **Degraded**: present and tested, but `createFailing` has no caller (26 bare `test.fails` instead); only the sentinels use `createFlake`, and they expire on 2026-10-01 (in flight) | T4                                                                                                                                                                                      |
| Flake dashboard (#2580)                                                                                                                          | **Present**, as an hourly Depot writer instead of check_run ingestion (a legitimate replacement); carries the Worker-era design and a credential in `os-legacy-backup`              | C3, B2; teach it to recognise one infrastructure blip (T7)                                                                                                                              |
| CI traces (#2681, #2697, #2703, #2718, #2722)                                                                                                    | **Degraded**: Preview OS only, legacy shapes, nested deploy spans get no input (`traceOperation`, in flight)                                                                        | B1, I5                                                                                                                                                                                  |
| Report viewer for traces and Playwright HTML (#2690)                                                                                             | **Lost**: it lived in the external iterate/config project                                                                                                                           | **Should return** if people open reports; decide (I5)                                                                                                                                   |
| Playwright HTML reports and test-results artifacts                                                                                               | **Restored** for Preview OS (#2925); missing on main                                                                                                                                | I5                                                                                                                                                                                      |
| Test telemetry (retry reporter, raw artifacts, finalizer, flake records)                                                                         | **Present**; PostHog delivery zero since #2494; the completeness guarantee is inert                                                                                                 | Decision 5, B3                                                                                                                                                                          |
| Preview work selection and settled-ancestor inheritance (#2712)                                                                                  | **Lost**                                                                                                                                                                            | **Should return** in its cheap form (I6)                                                                                                                                                |
| Shared main/PR preview CI (#2658)                                                                                                                | **Degraded**: main re-implements it as a near-copy workflow                                                                                                                         | One reusable workflow (I5)                                                                                                                                                              |
| Baked preview dependencies and fingerprint reuse (#2696, #2717)                                                                                  | **Present** (`scripts/depot-ci/dependencies.mjs`); the baked-workspace invariant test was dropped                                                                                   | Test restored in the ci-lint-tooling PR                                                                                                                                                 |
| e2e-policy budget ladder and its guard test                                                                                                      | **Degraded**: dead constants, guard test lost                                                                                                                                       | Trim in flight; bring the guard back (T7)                                                                                                                                               |
| `fetch-safe-port` (the WHATWG bad-port fix)                                                                                                      | **Degraded**: only in dummy-petshop                                                                                                                                                 | Move it to shared test support (in flight)                                                                                                                                              |
| DO duration alarm                                                                                                                                | **Present** (moved to `scripts/ci`)                                                                                                                                                 | Move its Doppler project (C3)                                                                                                                                                           |
| Mobile/Metro specs, sharding and the capacity reporter, slot erasure, version-override headers, the rollout gate, `typm`, the codegen generators | **Legitimately gone**: their subjects were deleted                                                                                                                                  | Do not restore (lost-lint-ts#14)                                                                                                                                                        |

## 9. Dead code still suspected

| What                                                                        | Where                                                                                                                                                                                                                                                                                      | Why it looks dead                                                                                                                                                          | Action                                                                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **X1.** Menubar approval path (about 400 of 914 lines)                      | [`packages/iterate/menubar/Iterate.swift:148`](../packages/iterate/menubar/Iterate.swift#L148)                                                                                                                                                                                             | `startLegacyApprovalWatcher` has no caller. It spawns `iterate approve`, which the CLI no longer has, and the UI says "Approvals are not available on OS Next yet." (:656) | Delete, keeping login state (decision 8; sdk#4, docs#25, prs-restores#21, backcompat-sweep#9, naming-homogeneity#18)         |
| **X2.** dummy-petshop surfaces                                              | `apps/dummy-petshop/src/gateway.ts` (235 lines), `github-app.ts` (124), their tests, and the webhook, fault-injection, `/rpc` and `/__backdoor/state` routes                                                                                                                               | No consumer outside the petshop                                                                                                                                            | Decision 12 (small-apps#0)                                                                                                   |
| **X3.** `SourceCodeBlock` editing machinery, and a second CodeMirror viewer | [`packages/ui/src/components/source-code-block.client.tsx:29-39`](../packages/ui/src/components/source-code-block.client.tsx#L29-L39)                                                                                                                                                      | `editable`, `onChange`, `onModEnter`, `selectAllSignal` and the rest are never passed                                                                                      | Delete the props, then merge the viewers (ui-shared#12)                                                                      |
| **X4.** Presence demo processor in production `src/`                        | `apps/os/src/client/presence/`, bundled by `scripts/build.ts:42` on every build                                                                                                                                                                                                            | Only `e2e/support/sources.ts` uses the bundle                                                                                                                              | Move it to `apps/os/e2e/fixtures/` (os-issuer#12, architecture#15)                                                           |
| **X5.** `deployApp`'s `afterDeploy` hook                                    | [`scripts/lib/deploy-app.ts:67`](../scripts/lib/deploy-app.ts#L67), :108                                                                                                                                                                                                                   | Nothing passes it (#2947 kept it)                                                                                                                                          | Delete                                                                                                                       |
| **X6.** Kit firmware leftovers #2952 did not take                           | `getProcessorRuntimeState` polling (`voice_stream.c:716`); `micDropped` (never incremented) and `spkDrops` (always equals `spkAnswerStarts`) (`voice_loop.c:1981`, :2056); `SILENT_OUTPUT`; the Python ITERKIT1 encoder beside the tested `config-image.ts` (`tools/make-config-image.py`) | No sender, no writer, no target, or a second writer                                                                                                                        | Decision 12; delete the counters; make the Python tool a thin wrapper over `config-image.ts` (kit#2, kit#11, kit#22, kit#18) |

Also dead, and covered above: the CI PostHog event builders (decision 5), the legacy CI-trace shapes (B1), do-reset's container and legacy-migration paths (B4), the opt-in e2e probes nothing runs (C6), lint rules with no subject (I9, decision 7), the repo's `readModules` and the workspace mount `{ repo }` (A6), and about 150 unused exports in packages/shared and packages/ui that knip's export-map posture hides (I9).

## Appendix A: finding ids

One line per finding in this document, with the section it appears in. The titles are the reviewers'; some describe the state before tonight, and the section text above is current.

- os-stream#7: SDK engine tests and the shared processor harness live in apps/os/src/stream, and apps/agents imports them across apps → A3
- os-stream#11: Constructor recovery for a missing core checkpoint exists for 'a store from before the SQL layout' → B5
- os-stream#13: Three test.fails rows pin known open bugs (a committed append whose error reply exceeds the RPC cap; parsed-cost OOMs) with no tracking issue or revisit date → C5
- os-context#16: Pull the DO's in-flight counting, quiet clocks and in-memory deadlines out of the 1,400-line IterateContextDurableObject → A1
- os-context#17: The six first-party facets are listed in three parallel tables → A12
- os-context#18: Use the workers-types `Artifacts` binding type and its `ArtifactsError.code` instead of the hand-typed namespace and the `/not found|10200/` regex → A12
- os-entities#5: ControlPlane edge: replace the string-dispatched `#call` with typed stub calls, and use one method vocabulary across database, DO and edge → A9
- os-entities#8: Repo facet has two public verbs that build a worker's modules from a repo: `readModules` and `modules` → A6
- os-entities#9: Workspace mount `{ repo }` always equals its own mount path → A6
- os-entities#10: Merge the copy-pasted repo and workspace processors, their tests and their created-guards → A6
- os-entities#24: Consolidate hex and base64 byte helpers that are hand-rolled across apps/os → A12
- os-issuer#12: The e2e-only presence demo processor lives in production src/ and is bundled on every worker build → X4
- os-issuer#22: No per-request edge context: platform addresses, the control plane and the app config are recomputed across ~15 functions → A8
- os-tests#9: The shadow-a-built-in-root row is duplicated for ai and browser → T3
- os-tests#18: Overlapping e2e rows across the rpc-stub, delivery and Artifacts files → T3
- os-tests#27: Three opt-in probes are never run by any workflow or documented; one pins a known hop-budget gap → C6
- os-tests#28: The lane/door/seam metaphor ban is violated about 360 times in test scope, including four file names → Decision 6
- os-tests#30: No shared test-support module across the node e2e, workerd and Playwright lanes → T3
- os-tests#31: Banned `describe` blocks, a pure-reducer unit test in the workers lane, and empty skipped placeholders → T7
- os-scripts#1: Self-hosting (and ensure-resources) never creates the Artifacts namespace the Worker binds, so project creation fails with "Namespace is not active" → C4
- os-scripts#10: Public or persisted "OS Next" names: the OS_NEXT_ENV env var, self-host docs and setup prompt, PR-body markers → Decision 2
- os-scripts#14: Three ways OS scripts get the admin bearer; control-plane-load and inspect-context need a shell `node -p` dance that deployedTarget already does → N2
- os-scripts#15: The capnweb operator session over undici is hand-rolled three times, and the operator surface is typed locally each time, although iterate/next/node connectOsNext exists → A12
- os-scripts#16: Emptying Artifacts namespaces and R2 buckets is implemented twice, differently: erase-data vs preview → C9
- os-scripts#17: The OS config and build pipeline was not homogenized with the Start apps (#2904): a config is generated for every env and then flattened, buildOsNext copies buildStartApp, and wrangler.test.jsonc hand-copies the base → A7
- os-scripts#18: preview.ts is a 1,327-line module split by 10 section banners, with about a dozen scattered process.env reads and two process-runner helpers with different env semantics → A12
- os-scripts#24: AgentDurableObject `state: deleted` tombstone kept in exports → B5
- agents#2: Agent page opens a second live-state subscription for the `agent` facet that `useIterateContext` already holds → A10
- agents#10: `itx.agents.create(path, { creator })` lets any caller choose the new agent's parent link; nobody passes it → C2
- agents#14: Voice install keeps the `kit/voice/` KV prefix and `kit/install/` key only for compatibility → B5
- agents#19: The voice delegate runs a second agent loop beside the app's AgentProcessor → A11
- agents#20: The feed translates the context's runs into legacy `capability-host` vocabulary for a 1,727-line packages/ui reducer that only apps/agents uses → A10
- agents#21: The 'public SDK only' app's unit tests import apps/os internals and packages/iterate sources by relative path → A3
- agents#22: `configs-next` template directory still carries the os-next suffix → Decision 9
- dash#1: Dash hardcodes production app origins, so a per-PR preview dash links to the production agents/notes/voice apps → C10
- dash#11: The dash has no browser specs: seven test ids have no reader, and the PAT spec was deleted when the dash moved out → T5
- dash#18: Four TanStack Start apps carry near-identical server.ts, \_\_root.tsx, router.tsx, Env declarations and LiveStateValue → A7
- small-apps#0: dummy-petshop: delete the surfaces nothing calls (WebSocket gateways, GitHub App, webhooks, fault injection, oRPC /rpc, /\_\_backdoor/state) → Decision 12, X2
- small-apps#8: notes (and dash overview) treat `creation: null` as ready 'for a project born before the saga existed' → B5
- small-apps#11: Dependency version drift across packages (four vitest versions in the lockfile); only Cloudflare uses a pnpm catalog → I8
- small-apps#16: Rename configs-next/ to configs/ (the last '-next' directory) → Decision 9
- small-apps#19: Same project-context hook and liveSnapshot seed callback copied across dash, notes, voice and agents → A7
- small-apps#20: Start-app boilerplate is copied per app and has already drifted (server entry, root, router, \_auth, landing) → A7
- small-apps#21: Three different deploy mechanisms among the small apps → A7
- small-apps#22: voice (and kit) import apps/agents source by relative path with no declared dependency → A7
- small-apps#23: Static SPA and browser extension carry two copies of the OAuth client and three pins of capnweb → A12
- kit#2: Remote face/viseme polling calls `getProcessorRuntimeState`, which nothing implements, every 100 ms on Waveshare AMOLED → Decision 12, X6
- kit#11: Health counters that never move or duplicate another (`micDropped`, `spkDrops`), plus a stale probe name → X6
- kit#16: 'One status language' is implemented by three different renderers → A12
- kit#17: Three boards hand-assemble the same avatar presentation pipeline → A12
- kit#18: Two ITERKIT1 provisioning-image encoders (Python tool and config-image.ts) → X6
- kit#19: The sprite pipeline is stranded: its rebuild gate is missing, its inputs are not committed, and it emits atlas C a second way → Decision 12
- kit#22: Compile-time ITERATE_KIT_DIAGNOSTIC_SILENT_OUTPUT is enabled by no target → Decision 12, X6
- kit#23: Waveshare RLCD and ZECTRIX NOTE4 device files are near-duplicate 'text status screen' boards → A12
- sdk#4: Menubar still ships the whole legacy approval watcher, notification plumbing and signing path, plus docs that point to deleted code → Decision 8, X1
- sdk#5: CLI hand-rolls PKCE, token exchange and refresh (with leftover DCR/legacy fields) instead of using oauth4webapi and the package's own authorizationCodeRequest → Decision 8
- sdk#8: The `iterate/next/*` subpath namespace is itself a two-SDK leftover → Decision 8
- sdk#17: The public SDK ships platform internals that only apps/os imports → A4
- ui-shared#2: Two git protocol-v2 clients: packages/shared/src/config-repo-template/git-wire.ts (legacy, 689 lines) duplicates apps/os/src/repo/git-wire.ts (726 lines); roughly half of the shared copy is dead write-side code → A5
- ui-shared#6: apps/agents translates os-next's script events into the legacy platform's vocabulary so the shared reducer can read them, backfilling fields the current platform does not have → A10
- ui-shared#8: Dark mode is dead but still carried: every app forces light, yet packages/ui ships next-themes, a `.dark` palette and dark: variants → Decision 12
- ui-shared#10: CI telemetry contract fields and env inputs that no producer writes any more; the 'a runner cannot silently disappear' completeness check is inert → B3
- ui-shared#11: FlakeSuiteSummary keeps `tests` optional for 'older artifacts' → B2
- ui-shared#12: Two CodeMirror read-only viewers (SourceCodeBlock and SerializedObjectCodeBlock), each with its own CodeMirror, copy button and fold service; SourceCodeBlock's editing machinery and SerializedObjectCodeBlock's debug props are unused → X3
- ui-shared#14: Knip can't see dead code in packages/shared and packages/ui because it treats their package.json export maps as public entry points → I9
- ui-shared#15: packages/ui mixes two import styles, adds a tsconfig paths hack only it uses, sprinkles meaningless "use client", and names pure modules .tsx to fit an export glob → N6
- ui-shared#18: createFlake and createFailing duplicate the same registration and timeout machinery (and the same tests) → T4
- ui-shared#19: packages/shared is mostly single-consumer modules; move each next to its only consumer → A12
- ui-shared#20: Four vitest versions resolve across the workspace; the retry reporter works around the drift with structural types → I8
- scripts-ci#0: CI PostHog telemetry is downsampled to zero, but ~1,500 lines plus a 15-minute workflow still build events that are dropped → Decision 5
- scripts-ci#1: The CI-trace assembler, CLI and shell hook still model the deleted legacy preview-run.yml pipeline → B1
- scripts-ci#2: do-reset still parks container-bearing classes and legacy migrations-mode workers that no longer exist → B4
- scripts-ci#5: Account-wide Cloudflare tooling reads credentials from a third Doppler project, ignoring envs.ts `cloudflareAccounts`; stale preview-slot comments → C3
- scripts-ci#9: "Our own zones" is derived twice: start-app ownZones() and apps/os ownZonesOf(); ownZones also hard-codes 19 legacy iterate-preview-N.app zones → I10
- scripts-ci#13: Four styles of CLI entrypoint and main-module detection across scripts/ci → I10
- scripts-ci#15: The flake dashboard fold still has the legacy stream processor's event-sourcing design → B2
- scripts-ci#22: Workflow-shape tests are spread over four files, each with its own YAML loader and types, and some assert on source text → I10
- scripts-ci#23: Four scripts reimplement "use Slack channel history as the state store" in their own ways → I10
- lint-tooling#0: The husky prepare-commit-msg history-rewrite guard never fires under Claude Code (#2932 fixed only lint-staged) → Decision 10
- lint-tooling#6: Dormant and subject-less lint rules: arm the two that have subjects; decide on the rest → Decision 7
- lint-tooling#8: Missing import extensions are checked twice: native import/extensions and iterate/relative-import-extensions → I9
- lint-tooling#13: Version drift across workspaces: 4 vitest versions, 2 vite versions, several @types/node, and zod specifiers that can silently drop the zod patch → I8
- lint-tooling#17: Specs harness: identical password sign-in helpers, a duplicated target-URL default, repeated env gates, and redundant fixture parameters → T6
- lint-tooling#18: The same target URL has two env var names: DEMO_BASE_URL/DEMO_PORT for Playwright, WORKER_BASE_URL for vitest e2e → N2
- lint-tooling#19: tsconfig strictness drift: erasableSyntaxOnly and verbatimModuleSyntax in only three packages; four configs ignore tsconfig.base.json → I9
- lint-tooling#22: One root vitest `projects` config instead of 11 per-workspace `vitest run --reporter=<long relative path>` scripts → A12
- docs#9: Three env var names for one admin bearer: ADMIN_API_SECRET, APP_CONFIG_ADMIN_API_SECRET, secrets.adminBearer → N2
- docs#10: DEMO_BASE_URL/DEMO_PORT is a legacy name for the OS target that WORKER_BASE_URL already names → N2
- docs#12: Public SDK export `connectOsNext` in iterate/next/node carries the os-next name → N1
- docs#13: Delete docs/preview-e2e-flake-hunt.md, a 1772-line log of the legacy slot fleet → Decision 7
- docs#16: The CI trace assembler still accepts the legacy pipeline's shapes; its env inputs have no setter → B1
- docs#17: ci-test-telemetry.md documents the deleted orchestrator; the telemetry schema keeps its dead fields and env vars → B3
- docs#18: CI telemetry still builds PostHog events that posthog-events.ts drops, including a 15-minute scheduled sync → Decision 5
- docs#25: Menubar keeps dormant legacy approval code, and its README cites TypeScript modules that no longer exist → Decision 8, X1
- docs#28: The lane/door/seam terminology rule conflicts with 755 uses, including the public SDK's `door` option → Decision 6
- lost-lint-ts#4: Three lint rules are armed at error but have nothing to check: isolated-codemode (dead since #1447), unicorn-js/isolated-functions, codegen/codegen (zero codegen blocks) → I9, section 9
- lost-lint-ts#9: Nothing enforces rules/\*_/_.md any more: the GitHub AI linter that did went with #2837, and the lane/door/seam ban now has 756 hits → Decision 6
- lost-lint-ts#11: Two rules report the same missing relative import extension: native import/extensions and iterate/relative-import-extensions → I9
- lost-lint-ts#13: 1,846 lines are still exempt from test-style and truthiness rules; the grandfathering is a backcompat layer for pre-cutoff code → I3
- lost-lint-ts#14: Lint/TS pieces that #2837 deleted legitimately, listed so nobody restores them by mistake → T2
- lost-playwright#1: Pinned-bug convention split: docs require createFailing, but 14 os rows use bare test.fails and call it "the house convention" → T4
- lost-playwright#3: Spec harness lost its operator handle (legacy fixture.itx), so specs hand-roll admin sessions and copy sign-in, slug and client-id helpers → T6
- lost-playwright#7: Two diverging `until` polling helpers, one in the Workers lane and one in the e2e lane → T3
- lost-playwright#11: Two env var names for "the OS deployment under test": DEMO_BASE_URL/DEMO_PORT for specs, WORKER_BASE_URL for e2e → N2
- lost-playwright#13: middlewright is pinned to an unreleased pkg.pr.new build; the lockfile reports it as version 0.1.0 → Section 8
- lost-playwright#16: docs/preview-e2e-flake-hunt.md is a 1,772-line evidence log of the legacy preview pipeline, restored verbatim → Decision 7
- lost-playwright#18: 1,626 grandfathered test-style violations: the rules are restored but the corpus is not homogeneous → I3
- lost-playwright#19: Dash and Agents client apps have no browser spec project, although the harness now supports them → T5
- lost-ci#0: CI trace assembler, CLI and shell hook still model the deleted preview-run.yml pipeline (finish verdict, milestones, shards, preview: job prefix) → B1
- lost-ci#2: The Depot artifact viewer is gone: CI trace and Playwright HTML reports (#2681, #2690) are download-only, and the `public-` artifact prefix is now meaningless → I5
- lost-ci#3: Main no longer goes through the shared preview CI (#2658): three near-copy e2e workflows, and main gets no CI trace and no Playwright evidence → I5
- lost-ci#4: CI telemetry sync runs every 15 minutes and discards everything: PostHog delivery is zeroed, and the sync keeps no artifact → Decision 5
- lost-ci#5: The test-telemetry and flake-summary contracts still carry the deleted preview orchestrator's fields and 'older artifact' tolerance → B3
- lost-ci#9: The flake dashboard writer ports the Worker-era stream processor into a batch CI script (legacy offsets, birth event, proposal events, hand-rolled zip reader) → B2
- lost-ci#10: The flake dashboard's live GitHub App credentials come from a Doppler project named `os-legacy-backup` → C3
- lost-ci#11: Preview work selection (#2712) is gone: every in-path push deploys all apps and runs the full e2e and the residency wait, and the `apps=auto` selector is reachable only by manual dispatch → I6
- prs-platform#5: Only one of the platform-fault workarounds logs the `<area>.platform-failure-<action>` warn the engineering invariant requires → C7
- prs-platform#9: #2830 re-copied rein-in 3's single entity pattern into apps/agents and writes the parent link at a different layer, with a different key and target → A6
- prs-platform#10: Seven overlapping residency mechanisms landed in one day with no single account; the DO grew back 275 lines, their idle clocks disagree, and the watchdog's warn is read by no alarm → A2
- prs-platform#12: Rein-in row 14 still open: repo `readModules` survives beside its replacement `modules()` (#2790), reachable only from an e2e row → A6
- prs-platform#13: Rein-in row 9 never landed: app-config narrows ingressRouting by hand and warns on unknown keys instead of letting the schema say it → B5
- prs-platform#14: The platform's MCP server still announces itself as 'control-plane', now the name of the #2888 singleton DO → N3
- prs-clients#0: Agent feed shows "The durable script settlement is invalid." for every interrupted run: the reducer's settlement schema predates the `interrupted` failureKind → C1
- prs-clients#3: PostHog is three integrations with diverging settings: packages/ui's browser setup, an inline posthog-js init on the issuer, and posthog-node on the issuer server → N5
- prs-clients#6: Kit is the only client app without PostHog (no key, no /e proxy, no identity) → Decision 12
- prs-clients#7: The five TanStack apps are homogeneous by copy: server.ts, router.tsx, \_\_root.tsx and the Env declaration are repeated byte for byte → A7
- prs-clients#9: The agents page subscribes to the agent facet's live state twice: useLiveState('agent') beside useIterateContext, which already opens every hosted facet → A10
- prs-clients#13: Two git protocol-v2 implementations: packages/shared/config-repo-template/git-wire.ts (added by #2830) beside apps/os/src/repo/git-wire.ts → A5
- prs-clients#17: apps/os has no route-tree check, and four apps' scripts/app.ts and vite.config.ts are never type-checked → I7
- prs-restores#0: Restored docs are full of history narration about what #2837 deleted → D1
- prs-restores#1: CI trace and telemetry code and docs still support the deleted preview-run.yml pipeline → B1
- prs-restores#2: #2881 restored a 1,772-line legacy flake-hunt log a day after #2808 deleted history docs → Decision 7
- prs-restores#17: rules/\*_/_.md lost its enforcer with #2837 and is widely violated → Decision 6
- prs-restores#18: #2837 deleted the rein-in plan while it still had unfinished items → D3
- prs-restores#19: Dash's app directory hard-codes prd URLs from envs.ts; the Voice link is stale → C10
- prs-restores#21: Menu-bar app keeps a legacy approval watcher that calls a CLI command that no longer exists → Decision 8, X1
- prs-restores#22: Two env var names for the OS under test: DEMO_BASE_URL (specs) and WORKER_BASE_URL (e2e) → N2
- prs-restores#23: apps/os uses its own Worker-config system after #2904 homogenized every other Start app → A7
- prs-restores#24: Restored flake tooling still handles legacy record and summary shapes and legacy preview slots → B2
- prs-restores#25: Restored dormant lint rules guard code that no longer exists; one points at a missing wrapper → Decision 7
- prs-restores#26: The Doppler project for apps/os is still called `project-worker`, unlike every other app → Decision 2
- backcompat-sweep#3: CI trace assembler still models the deleted legacy `preview-run.yml` pipeline (finish-job verdict, plan/prepare/shard labels, reusable-workflow job keys, env markers nobody sets) → B1
- backcompat-sweep#4: do-reset keeps the legacy-migrations raw park and container-class retention, but its only caller has no container classes and runs on the exports flow → B4
- backcompat-sweep#7: Flake dashboard still parses 'legacy' count-only suite summaries and kind-less records, and its fold is documented as a port of the deleted app → B2
- backcompat-sweep#8: Voice install keys stay under the `kit/voice/` KV prefix 'so installed projects keep their keys', but installs are content-addressed and never re-read old keys → B5
- backcompat-sweep#9: Menubar app keeps the dormant legacy approval watcher, approval UI and notification plumbing; its README points to TypeScript approval modules that no longer exist → Decision 8, X1
- backcompat-sweep#10: Five custom lint rules are registered but never armed because their subject 'went with the legacy platform' → Decision 7
- backcompat-sweep#15: The shared agent-UI reducer still speaks the legacy platform's event vocabulary; apps/agents translates current events back into legacy names for it, and the reducer keeps branches for events nothing produces → A10
- backcompat-sweep#16: 'OS Next' / `next` names from the two-platform era are everywhere, although there is now one OS: SDK subpaths, env vars, CLI copy, docs, the template directory → N1
- backcompat-sweep#19: Docs and code comments narrate what 'went with #2837' / 'the legacy platform' instead of describing today's system → D1
- backcompat-sweep#20: Two near-copies of the git protocol-v2 wire client: apps/os/src/repo/git-wire.ts and packages/shared/src/config-repo-template/git-wire.ts → A5
- backcompat-sweep#21: Kit intercepts `/.auth/login` and `/.auth/connect` to redirect 'old bookmarks' to the device selector → B5
- backcompat-sweep#22: The CI telemetry doc mandates versioned backcompat migrations for raw artifacts, which contradicts the repo's no-backcompat rule → B3
- backcompat-sweep#23: envs.ts pins resource names to a pre-rename worker name, so prd resources are named `project-worker-prd-*` while the worker is `os-next-prd` → Decision 2
- naming-homogeneity#2: Public SDK/CLI/self-host surface still says 'OS Next': connectOsNext, CLI strings, OS_NEXT_ENV, `pnpm --filter os`, the served setup prompt → N1
- naming-homogeneity#3: Deployed resource names still carry os-next / project-worker (worker names, Artifacts namespaces, resource prefixes, Doppler project); leave them unless there is a deliberate migration → Decision 2
- naming-homogeneity#4: '-next' suffix is meaningless now: rename configs-next/ → configs/ → Decision 9
- naming-homogeneity#5: '-next' in the public SDK subpaths: flatten iterate/next/_ to iterate/_ → Decision 8
- naming-homogeneity#8: Five TanStack Start apps are homogeneous only by copy-paste: server.ts, \_\_root.tsx, router.tsx, vite.config.ts and the \_auth PostHog identify repeat per app → A7
- naming-homogeneity#9: Kit is the only first-party app without PostHog (no env key, no /e proxy, no provider, no identify) → Decision 12
- naming-homogeneity#13: envs.ts: three shapes for the same app env; Doppler project slugs hardcoded outside envs.ts → N4
- naming-homogeneity#14: Three env var names for 'the OS under test': DEMO_BASE_URL/DEMO_PORT (Playwright) vs WORKER_BASE_URL (vitest e2e) vs OS_BASE_URL (derived) → N2
- naming-homogeneity#15: Stale Doppler/env var name APP_CONFIG_ADMIN_API_SECRET (replaced by APP_CONFIG.secrets.adminBearer) → N2
- naming-homogeneity#18: Menubar app keeps ~400 lines of dormant legacy approval code (watcher for a CLI command that no longer exists) → Decision 8, X1
- naming-homogeneity#20: The shared agent-UI reducer speaks the legacy capability-host vocabulary, and its only consumer translates today's events into it → A10
- naming-homogeneity#21: Dependency specifier drift: 4 vitest versions installed, mixed zod and @types/node specifiers → I8
- naming-homogeneity#22: Three separate `cloudflare:workers` Node test shims → T3
- naming-homogeneity#24: House rule terminology/no-metaphorical-lane-door-seam is violated in ~760 code lines, including a public SDK option and a telemetry wire field → Decision 6
- naming-homogeneity#25: CI trace tooling still supports the deleted preview.yml reusable workflow, its 'finish' job and old ci-trace.yml artifacts → B1
- naming-homogeneity#28: apps/spa follows none of the app conventions (hand-rolled argv parsing, bespoke deploy, no typecheck) → A7
- architecture#0: Two forked git protocol-v2 codecs (~700 lines each): packages/shared config-repo-template/git-wire.ts vs apps/os repo/git-wire.ts → A5
- architecture#2: SDK engine and codec tests, and the processor test harness, live in apps/os; apps/agents imports them across apps → A3
- architecture#3: IterateContextDurableObject (1407 lines) holds four cohesive subsystems inline; extract them and make the DO wiring only → A1
- architecture#4: `iterate/next/expression` (public SDK) ships platform-only dispatch internals; `iterate/next/stream/processor` is the home of the platform's core event envelope → A4
- architecture#6: Two sources of truth for orgs and memberships: the control-plane SQLite catalog, and fire-and-forget folds that the dash renders → C8
- architecture#7: Entity lifecycle (creation/deletion saga, catalog, collection) is implemented twice: platform repo/workspace and userspace agents → A6
- architecture#8: The `iterate` CLI hand-rolls OAuth (registration, PKCE, token exchange, refresh) though the same package ships an oauth4webapi-based flow → Decision 8
- architecture#10: apps/os/src top level mixes issuer, secrets, context core and library; the secret feature alone spans 7 files in 3 places → A12
- architecture#11: Test-pyramid gaps and couplings: untested dash and agents UI, an `any`-typed e2e harness that never proves the SDK's API, a cross-app harness, and a stale workers-lane charter → T2
- architecture#12: packages/iterate bundles the CLI, a macOS menubar app and the SDK; legacy-era naming and dependencies remain → Decision 8
- architecture#13: Client apps copy the same server entry, auth route and router; voice and kit bundle agents' internals through relative imports → A7
- architecture#14: A registry of first-party facets is split across four hand-synced tables → A12
- architecture#15: An e2e-only fixture (presence processor) lives in production src and is compiled by the production build → X4

**From the CI audit** (`ci-audit`, same night):

- timings-flakiness#6: Required checks test the stale PR head; two semantic conflicts broke main and one shipped to prd → Decision 3, I1
- dumb-patterns#5: `release.yml` tags the whole monorepo daily; releases nobody consumes → Decision 4
- local-vs-ci#4, dumb-patterns#15: git-blame grandfathering forces `fetch-depth: 0` and makes local lint slow → I2
- local-vs-ci#5: the local checkout is a blobless partial clone → I2
- local-vs-ci#8: `prepare-commit-msg` never fires under Claude Code → Decision 10
- local-vs-ci#9: OS has no `routes:check` → I7
- dumb-patterns#16: alarm workflows on a vanilla runner with `curl | sh` Doppler → I4

## Appendix B: findings not included

**Fixed on main tonight** (checked against `0aaa8ae4b`):

- os-issuer#2 and prs-platform#3 (the retryable predicate, now `apps/os/src/retryable-error.ts`): #2939
- os-issuer#4 (MCP's global-namespace refusal), os-issuer#5 (`projectHostOf`), os-issuer#11, os-issuer#15 (`signInHref`/`switchAccountHref`), os-issuer#16, os-issuer#19, os-issuer#20, os-issuer#21: #2935
- os-issuer#14 (`Redacted` re-export; the shared config now lives in apps/os): #2935, #2944
- backcompat-sweep#18 (changelog comments above contract versions): #2939
- naming-homogeneity#12 (`shouldSendPosthogEvents`): #2944
- naming-homogeneity#17 (dangling README pointers, port 8797): #2936
- prs-clients#18 (unused `loginPath`, the dash scope list): #2944
- naming-homogeneity#19 (reducer branches for events nothing emits), prs-clients#10 (`LiveStateValue`, now in packages/ui): #2946
- naming-homogeneity#23 (Kit's "a project id IS its slug" claim): #2943, #2952
- naming-homogeneity#26 and small-apps#1 (petshop epoch scalar and blob migrations): #2945
- backcompat-sweep#17 (firmware compatibility typedef and unwritten diagnostics): #2952
- small-apps#9, and the typecheck half of naming-homogeneity#10 and prs-clients#17 (app scripts and configs typechecked): #2947

**In an open review PR:**

- prs-platform#2 (D1 replay and operator id-pinning) and prs-restores#12 (the DO-birth subscription shim): #2950

**In flight tonight, not yet opened:**

- naming-homogeneity#0, #1, #6, os-scripts#9, os-tests#29, prs-restores#9, lint-tooling#20: the internal os-next rename
- naming-homogeneity#7, #11 (deletions), #16, #27: ci-lint-tooling-cleanup
- lint-tooling#1, #2, #4, lost-lint-ts#0, #1, #2, #10, docs#27, prs-restores#13, naming-homogeneity#11 (widening): checks-cover-everything
