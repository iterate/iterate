# THE CLIENT SIDE — v4 vs v3 (generated types · browser clients · the /docs demo · Playwright)

## 1. What v4 has

**The headline finding: v4's browser client library is not a v4 addition.** These are byte-identical
between the trees (`diff` clean, 2026-09-07):

| file                              | code lines | status          |
| --------------------------------- | ---------- | --------------- |
| `src/client/live-state-client.ts` | 83         | IDENTICAL to v3 |
| `src/client/live-state-store.ts`  | 37         | IDENTICAL to v3 |
| `src/client/react.tsx`            | 67         | IDENTICAL to v3 |
| `src/client/demo.tsx`             | 122        | IDENTICAL to v3 |
| `specs/live-state-demo.spec.ts`   | 2 tests    | IDENTICAL to v3 |
| `playwright.config.ts`            | 20         | IDENTICAL to v3 |

`public/demo.html` (build output) and `e2e/live-state-chains-client-side.e2e.test.ts` are identical
too. So the v4-only client surface is exactly two arcs.

### (a) Generated client types — `build-types.mjs` (190 code lines)

Emits, from `tsconfig.json` and the two public roots `src/iterate-context.ts` + `src/session.ts`
(`build-types.mjs:11`), the declaration closure reachable from those roots plus the whole default-lib
chain, with every import specifier rewritten to content-addressed paths. Two outputs, both under the
git-ignored `src/generated/` (`.gitignore:3` — v3 by contrast COMMITS `src/generated/processor-sdk.ts`):

- `src/generated/type-files.ts` — 2.73 MB, `TYPE_FILES`, `TYPE_ROOTS`, `TYPE_DEFAULT_LIB_FILE`.
  Consumer: `src/bundler.ts:9,109,115,128` — the in-worker `itx.check` TypeScript host.
  **This is the repos/check/build feature's dependency, not the client's.**
- `src/generated/itx-types/` — 202 `.d.ts` files, 3.1 MB, the same bytes as a relative on-disk graph
  (`build-types.mjs:166-189`). Consumer: **exactly one line**, `src/client/docs.ts:9`:
  `import type { Itx, UnauthenticatedSession } from "../generated/itx-types/index.d.ts"`.
  Its `index.d.ts` is two lines: `export type { IterateContext as Itx }` and `export { Session,
UnauthenticatedSession }`. It also writes `/node_modules/itx/index.d.ts` declaring
  `ItxEnv { ITX: { get(): Promise<IterateContext> } }` — the shape loaded workers see.

How a consumer imports it: they don't, outside this package. `package.json` `exports` is `"." :
"./src/worker.ts"` only — same as v3. There is no `./types` entry in either tree.

### (b) The `/docs` collaborative Docs demo

| file                         | code lines | what                                                                                              |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `src/client/docs.ts`         | 495        | the whole page: DOM built by one `innerHTML` template, capnweb session, Yjs replica, publish flow |
| `src/client/docs.html`       | 14         | shell with a `__DOCS_BUNDLE__` sentinel                                                           |
| `build-docs.mjs`             | 45         | esbuild ×3 → inlines the bundle into `public/docs.html` (591 KB, vs demo.html's 260 KB)           |
| `examples/docs/processor.ts` | 57         | the USERSPACE Yjs processor                                                                       |
| `examples/docs/router.ts`    | 9          | a userspace ingress router                                                                        |
| `e2e/docs-app.e2e.test.ts`   | 183        | the vitest proof                                                                                  |

Plus `examples/docs/README.md` (the narrative). `build-sdk.mjs` gained exactly two lines over v3's:
`await import("./build-types.mjs")` (line 10) and `await import("./build-docs.mjs")` (line 79).

**API as spelled.** In order: `newWebSocketRpcSession<UnauthenticatedSession>(socket)` →
`api.authenticate()` → `session.projects.get(projectId)` → `itx.whoami()` / `session.identity()`;
`itx.enableProcessor("docs", { source: { "cap.js": DOCS_PROCESSOR_SOURCE, "yjs.js": DOCS_YJS_MODULE },
className: "DocsDurableObject", consumes: ["docs/update"] })`;
`itx.invoke("itx.facets.get('docs').snapshot()")`; `connectLiveState<DocsState>(itx, { key: "docs",
name, door: () => scope.invoke("itx.facets.get('docs').liveSnapshot()") })`; and for publish
`itx.repos.get(path).head()/.commit({parent,message,files})`, `itx.check(source)`, `itx.build(source)`.

**Events appended.** Three types:

- `docs/update` — `{ path: string, update: string }` (base64 Yjs delta), `idempotencyKey` a UUID.
- `events.iterate.com/docs/activated` — `{ repo, revision, buildKey, documentPath }`.
- `events.iterate.com/itx/rewrite-rule-configured` — `{ match: "itx.docs", target:
"itx.workers.load(<code>, { cacheKey })" }`, appended atomically beside the activation.

**Config/bindings/infra.** `yjs@^13.6.32` as a runtime dependency (v3 has none); `esbuild` at build
time; `wrangler.jsonc` `assets: { directory: "./public", binding: "ASSETS" }` — `/docs` is a **static
asset served by the Cloudflare assets layer before `worker.ts` runs** (`src/worker.ts:92-93` says this
for `/demo`; `/docs` appears nowhere in `worker.ts`). Publish needs `BUNDLER` (a second worker),
`BUILD_CACHE` KV and `itx.repos`; the login link needs `withOptionalDemoLogin` (`src/auth.ts:48`).

**Tests.** `e2e/docs-app.e2e.test.ts`, two tests in the `pnpm e2e` vitest lane, both
deployed-capable via `WORKER_BASE_URL` (`e2e/support/global-setup.ts:65-95`). Test 1: two capnweb
sessions' concurrent Yjs updates converge, replay from the log after disable/enable, then
commit→check→build→activate and serve the document through `/expression?context=…&itx=itx.docs`.
Test 2: the live-state delta reaches `connectLiveState`. **There is NO Playwright spec for `/docs`**
— `specs/` holds only `live-state-demo.spec.ts` in both trees, so README's "Two preview browser tabs
have converged" is a manual claim. `docs.ts` also imports `../context/expression.ts` (`parse`,
line 8) — a platform module compiled into the browser bundle to pre-validate the rewrite target.

## 2. What v3 has today for the same need

- **The client library: already there, identical.** `connectLiveState` / `LiveStateItx` /
  `LiveStateConnection`, `createLiveStateStore` / `LiveStateDelta` / `LiveStateSeed`, `useLiveState`
  / `LiveStateStatus`, `demo.tsx`. Bundled to `public/demo.html` by `build-sdk.mjs:56-75`, served as
  a static asset (`wrangler.jsonc:40`). Zero porting work.
- **The Playwright lane: already there.** `pnpm spec` → `playwright test`, with the `DEMO_BASE_URL`
  swap that skips booting a local worker. (`@playwright/test` is a devDependency of neither package
  — it resolves from the monorepo root.)
- **Types: no home.** Gap 8 verbatim (`docs/assessment-userspace-apps-on-the-clean-room.md:311-319`):
  "the type of what a client holds is the `IterateContext` interface merged with `BuiltInScope` …
  A `types.ts` export map entry, no runtime." `package.json` `exports` is `"."` → `src/worker.ts`.
- **The Docs shape: assessment §5** (`:334-367`) already maps it — one context per workspace, a
  `WorkspaceDurableObject` facet, `LiveState "board"`, `rule itx.apps.docs ⇒ itx.workers.get(...)`,
  `ingress: docs--<slug>.<base>`. Tonight's `src/project-host.ts` closed the ingress half;
  `e2e/ingress-project-host.e2e.test.ts:52` is the working spelling:
  `await itx.provide("itx.apps.site", "itx.workers.get({ source })")`, then `site--<projectId>.<base>`.
- **No `itx.repos` / `itx.check` / `itx.build`.** v3's `src/` has no `repos.ts`, `build.ts` or
  `bundler.ts` (Gap 3). `docs.ts`'s `save` handler has no landing ground.

### Where v4 conflicts with v3's doctrines

1. **`/docs` is platform code.** The editor page is a wrangler static asset on the _platform_
   hostname (`https://v4.iterate2.app/docs?project=prj_v4_demo`, README:175). Applying the litmus
   test — could this be written in a userspace worker? — yes, entirely; tonight's ingress exists
   precisely so it is. v4 shipped it as platform because it forked before that ingress landed.
2. **`examples/docs/router.ts:7` hardcodes hostnames in userspace:**
   `new Set(["docs--v4-demo.iterate2.app", "v4-custom.iterate2.app"])`. v3's ingress resolves
   `<label>--<projectId>.<base>` at the edge into `itx.apps.<label>` and, per as-built §10, "the log
   never names a hostname." The router is dead weight against v3.
3. **`Itx` is a short name the platform spelled.** `build-types.mjs:163-165` aliases
   `IterateContext as Itx` and invents a package identity `node_modules/itx`.
4. **3.1 MB of generated `.d.ts` to satisfy one type import.** `src/generated/itx-types/` exists
   solely for `docs.ts:9`; its real justification is `src/bundler.ts`, a different feature. For
   Gap 8 alone this is speculative machinery.
5. **A browser page importing `src/context/expression.ts`.** `docs.ts:8` puts the platform's
   expression parser in the page bundle. Under `src/iterate-context.ts:5-8` ("There is no client SDK
   and none may be introduced — a client's whole dependency is the capnweb package"), that is a new
   client-side platform dependency.
6. **`.gitignore`s `src/generated/`.** v3 commits `src/generated/processor-sdk.ts` on purpose
   ("committed so typecheck works without a build", `build-sdk.mjs:4-5`).

## 3. Proposed layering on v3

**(a) Gap 8 — types. Hand-written `types.ts`, not generated.** Two export-map entries:

```jsonc
"exports": {
  ".":       "./src/worker.ts",
  "./types": "./src/types.ts",                      // types only, no runtime
  "./client": "./src/client/live-state-client.ts"   // the runtime client, already written
}
```

`src/types.ts` is a pure re-export file, ~8 lines, no new names: `type IterateContext` from
`./iterate-context.ts`; `type Session`, `type UnauthenticatedSession`, `type SessionPrincipal` from
`./session.ts`; `type Principal` from `./principal.ts`; `type StreamEvent`, `type StreamEventInput`
from `./stream/events.ts`; `type LiveStateSeed`, `type LiveStateDelta`, `type LiveStateStore` from
`./client/live-state-store.ts`; `type LiveStateConnection`, `type LiveStateItx` from
`./client/live-state-client.ts`.

Names stay full — `IterateContext`, never `Itx`. Deliberately left out: any `ItxEnv` interface (loaded
workers get `env.ITX` from `src/itx-entrypoint.ts` and the injected `processor.js`, not a `.d.ts`);
any generated graph; any runtime in `types.ts`.

**Do NOT port `build-types.mjs` for the client.** It should arrive with `itx.check` if that feature
is taken, and its only client-side consumer disappears once `types.ts` exists.

**(b) Docs is USERSPACE.** The whole thing, per the litmus test:

- **the page** — `itx.provide("itx.apps.docs", "itx.workers.get({ source: { 'cap.js': <page worker> } })")`,
  or the durable `events.iterate.com/itx/rewrite-rule-configured` fact when it must outlive the
  session. Served at `docs--<projectId>.<base>/`. Identity comes free: `/.itx/session?token=…` sets
  the cookie and the app sees `x-itx-principal` (as-built §10, Project hosts).
- **the processor** — `examples/docs/processor.ts` verbatim; it extends only `StreamProcessor` /
  `StreamProcessorDurableObject` / `defineProcessorContract` / `z` from `./processor.js`, all of
  which v3's `src/sdk/index.ts` already exports.
- **the events** — `docs/update` `{ path, update }` unchanged; drop
  `events.iterate.com/docs/activated` until `itx.repos` exists. **The doors** — `/api` for edits,
  the project host for the page. No new platform door.

Deliberately left out of v3: `examples/docs/router.ts` (v3's ingress already does label routing),
the publish/`save` half, `itx.check`/`itx.build`, `Itx` as a name, `/docs` on the platform host.

**Where v4 is better than v3:** the `define`-injection in `build-docs.mjs:33-36`
(`DOCS_PROCESSOR_SOURCE`, `DOCS_YJS_MODULE`) is a genuinely good pattern — the processor is authored
as real typed TypeScript in `examples/`, esbuild turns it into the literal module bytes
`enableProcessor` wants, and no string-literal source lives in the page. v3 should adopt it, along
with `docs.ts`'s `connectionGeneration` guard (every async continuation checks it before touching the
DOM) and the failed-update `retry`/`revert` pair — honest UI for a durable-append client.

## 4. Implementation sketch

1. **`src/types.ts` + export map.** Add the file and the two `exports` entries. Proof: a sibling
   `src/types.test.ts` asserting every name resolves and `types.ts` has zero runtime imports;
   `pnpm typecheck` is the gate. Closes Gap 8. _(~15 code lines.)_
2. **`examples/docs/processor.ts` + `yjs` devDependency + `e2e/docs-app.e2e.test.ts`.** Port v4's
   processor verbatim and the first ~110 lines of v4's e2e (converge → replay → live), dropping the
   commit/check/build/activate tail. Proof, deployed: `WORKER_BASE_URL=https://project-worker.<sub>.workers.dev pnpm e2e -t "Docs"`. _(~57 + ~120 code lines.)_
3. **`src/client/docs.ts` + `build-docs.mjs`, minus publish.** Port the page; delete the `save`
   handler, the `parse` import and the `repo` input; import types from `./types.ts`, not a generated
   graph. Output to `public/docs.html`. Proof: `pnpm spec` locally first. _(~300 + ~35 code lines.)_
4. **Serve the page as `itx.apps.docs` on a project host.** A ~20-line userspace `WorkerEntrypoint`
   whose `fetch` returns the built `docs.html` (404 otherwise), installed with
   `itx.provide("itx.apps.docs", "itx.workers.get({ source })")`. Proof, deployed: a case shaped on
   `e2e/ingress-project-host.e2e.test.ts` — `docs--<projectId>.<base>/` returns the page, and with
   the `/.itx/session` cookie the append carries `source.principal`. _(~20 + ~40 test.)_
5. **`specs/docs.spec.ts` — the two-browser convergence proof.** Two Playwright pages on the same
   project host: type in one, assert the other's textarea converges; reload one, assert it retains.
   Proof: `DEMO_BASE_URL=https://<deployed host> pnpm spec` — the one thing vitest cannot do, and
   the one v4 claim that is currently manual. _(~40 lines.)_

## 5. Effort

| step                                          | code lines (v4 = upper bound)           | hours    |
| --------------------------------------------- | --------------------------------------- | -------- |
| 1 · `types.ts` + export map + proof           | ~15 (v4: 190 generated, not comparable) | 1        |
| 2 · processor + deployed vitest e2e           | ~177 (v4: 57 + 183)                     | 2        |
| 3 · page + build-docs, publish removed        | ~335 (v4: 495 + 45)                     | 3        |
| 4 · page as `itx.apps.docs` on a project host | ~60 (v4: 9, and wrong-shaped)           | 1.5      |
| 5 · Playwright two-browser spec               | ~40 (v4: 0)                             | 1        |
| **total**                                     | **~630 code lines**                     | **~8.5** |

Against v4's 989 code lines for the same arc, minus `build-types.mjs`'s 190 (deferred with
`itx.check`) and `router.ts`. Calibrated on tonight's ~300 code lines / ~3 hours with tests, docs and
a deployed proof; steps 3–5 are UI-and-browser work, which runs slower per line.

## 6. Dependencies and sequencing

- **Step 1 is fully independent** and should land first — it is 1 hour, closes a ranked gap, and
  every later step imports from it.
- **Step 2 is independent** of ingress and identity; it needs only `enableProcessor`, facets and
  `connectLiveState`, all shipped. `yjs` starts as an e2e-only devDependency, becoming a runtime one
  at step 3.
- **Steps 3–4 depend on tonight's project-host ingress** (`src/project-host.ts`, commit 773978230)
  and `APP_CONFIG_PROJECT_HOSTNAME_BASE` on the target deployment; step 4's identity assertion also
  on `src/principal.ts` + the `/.itx/session` cookie door. **Step 5 depends on 3+4** and on wildcard
  DNS for `<base>` (already there for `project-worker.iterate.com` per as-built §10).
- **The publish/activate half depends entirely on the repos+check+build feature** (v4's `src/repos.ts`,
  `src/build.ts`, `src/bundler.ts`, the `BUNDLER` service binding and `BUILD_CACHE` KV) — that is
  Gap 3 and another reviewer's area. Sequence it after, never as part of this.
- **Unblocks:** the assessment's step 3 ("the workspace facet in userspace") gets its first real
  userspace app on a project host; the tanstack-todos port (§7) becomes a copy of step 4.

## 7. Risks and questions for Jonas

1. **Platform `/docs` or userspace `itx.apps.docs`?** v4 shipped the editor page as a wrangler static
   asset on the platform hostname. I recommend userspace on a project host — it is what tonight's
   ingress is for, and the only version that proves the ingress carries a real app — but it costs
   ~1.5 extra hours and puts the page bytes in a loaded worker. Your call.
2. **Does `types.ts` carry runtime, or types only?** The assessment says "no runtime". I propose
   splitting `./types` from `./client` (`connectLiveState`). Confirm you want the client runtime
   exported at all, given "there is no client SDK and none may be introduced".
3. **`Itx` or `IterateContext` for external authors?** v4 aliases to `Itx`. I read that as the
   platform spelling a short name and propose against it; an app author's ergonomics may win.
4. **The Yjs bytes.** `public/docs.html` is 591 KB because minified Yjs is inlined twice (the page,
   and `DOCS_YJS_MODULE` for the processor). I **verified** v4's constraint: `src/repos.ts:277-278`
   rejects any file over 65,536 bytes, so a published Docs app genuinely cannot carry its own Yjs
   through a repo revision. v4's README calls for "a package/chunk layer"; that is unbuilt in both
   trees. Decide whether Docs-on-v3 sidesteps it (dependency bytes supplied at `enableProcessor`
   time, as v4's page does) or waits for it.
5. **Unverified v4 claims.** (a) README:175-181's two-tab convergence — no automated spec, and
   preview evidence has a ~3h shelf life, so I could not confirm it. (b) I ran no v4 test.
   (c) `pnpm typecheck` on a fresh v4 clone is unlikely to work, since `src/generated/` is
   git-ignored while `src/bundler.ts:9` imports from it — I did not run it to confirm.
6. **Is `project-worker` ever consumed as a package from outside the monorepo?** Its `exports` point
   at raw `.ts`. A `./types` entry only helps a consumer that compiles TypeScript source. If the
   intended app author is outside the repo, this needs a build step nobody has specified.
