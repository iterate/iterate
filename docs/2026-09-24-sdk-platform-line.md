# The SDK/platform line (proposal, 2026-09-24)

A proposal for the owner to decide. The branch that adds this file implements it, so the diff is
the concrete version of every sentence below. If it is accepted, move the rule itself (the
section [The rule](#the-rule)) into `packages/iterate/README.md` and delete this file.

## The question

> The idea is that the internal and external programming models are the same. Maybe the line
> blurs sometimes, but at the moment I don't even have a good sense of where the SDK is coming
> from. It feels like maybe we could make something more logical, like the SDK is a package that
> just re-exports some of the modules from our internal packages. I don't know what you would
> normally do in this situation.

The overnight review found three symptoms of the missing line (considerations A3–A5):

- **Platform runtime published as SDK API.** About 215 of `iterate/expression`'s 680 lines
  ran only in the platform: the dispatch half (`walkSteps`, `callOn`, the RPC brands,
  `itxAnswerDetachedFromSession`, `materializeItxHandleReference`). So did 160 of
  `iterate/principal`'s 171 (`Caller`, `stampCaller`, the signed claims, the admin secret's
  compare). Only apps/os imported either subpath.
- **The SDK's tests lived in the platform.** `ProcessorEngine` is SDK code, but its two suites
  (`processor.test.ts`, 1,438 lines, and `processor-rules.test.ts`, 595) ran in apps/os, and
  apps/agents imported its test harness from `apps/os/src/stream/test-support.ts`.
- **Two git protocol implementations.** `packages/shared/src/config-repo-template/git-wire.ts`
  (675 lines) was a fork of `apps/os/src/repo/git-wire.ts` (724), and apps/os bundled both.

## Recommendation

1. **The SDK is the programming model, and the platform is its first user.** One package,
   `iterate`, owns every module user code imports. apps/os builds its own entities (account,
   organization, project, repo, workspace, secret) on `iterate/sdk`, as a user's processor does,
   and every first-party app uses only `iterate/*`. That makes "the internal and external
   programming models are the same" a checked fact instead of an intention.
2. **The line is where code runs.** `iterate` holds what runs in user code (a loaded worker, a
   facet, a processor, a browser app, a Node script) and the contracts both sides speak (the
   API's types, the event envelope, the expression codec, the principal header). apps/os holds
   what only the platform's Worker runs. packages/shared holds private code that several apps
   share and user code never sees.
3. **The "list of re-exported modules" is the `exports` map.** Each subpath is one module of the
   SDK; everything not listed is internal. Node enforces that
   ([Node.js docs](https://nodejs.org/api/packages.html#package-entry-points): the `exports`
   field "prevent[s] any other entry points besides those defined", and "this encapsulation
   allows module authors to clearly define the public interface for their package"). That gives
   the list the owner asked for without a second package.
4. **No `@iterate-com/core` behind a thin `iterate`.** Reasons below.
5. **Enforce it.** A lint rule stops the SDK and the first-party apps importing `apps/os/src`, and
   the SDK's own tests run in the SDK.

## What comparable platforms do

All links are pinned to the commit read on 2026-09-24.

| Platform                  | Shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare workerd**    | Inside the runtime, each public module `cloudflare:<product>` is a thin re-export of `cloudflare-internal:*` implementation modules that user code cannot import ([`src/cloudflare/AGENTS.md`](https://github.com/cloudflare/workerd/blob/dd58d5b952a07b50b0ab33f2b890926f40ab3fa4/src/cloudflare/AGENTS.md), [`ai.ts`](https://github.com/cloudflare/workerd/blob/dd58d5b952a07b50b0ab33f2b890926f40ab3fa4/src/cloudflare/ai.ts)).                                                                                                                                                                                                                                                                                                                                                   | The owner's idea, done inside one component: "a clean separation between public API surface and internal implementation details". The separation is by module specifier, not by package. `workers.ts` re-exports only because "C++ built-in modules do not yet support named exports" ([`workers.ts`](https://github.com/cloudflare/workerd/blob/dd58d5b952a07b50b0ab33f2b890926f40ab3fa4/src/cloudflare/workers.ts#L5-L6)).                                                                                                                                                             |
| **Cloudflare Agents SDK** | One public package, `agents`, with 58 subpath exports, built on the runtime's public `cloudflare:workers` API. It shares no code with workerd ([`package.json`](https://github.com/cloudflare/agents/blob/f92420fea9f6f17d3a1f86dba6c8c0c054769a1f/packages/agents/package.json)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | When sibling first-party packages (`ai-chat`, Think) needed its internals, they went out through the public entry as `__DO_NOT_USE_WILL_BREAK__agentContext` and `__DO_NOT_USE_WILL_BREAK__withInvocationScope` ([`index.ts#L14-L20`](https://github.com/cloudflare/agents/blob/f92420fea9f6f17d3a1f86dba6c8c0c054769a1f/packages/agents/src/index.ts#L14-L20), used by [`ai-chat`](https://github.com/cloudflare/agents/blob/f92420fea9f6f17d3a1f86dba6c8c0c054769a1f/packages/ai-chat/src/index.ts#L11-L12)). Internals that more than one package needs leak into the public surface. |
| **Convex**                | The public `convex` package (`convex/server`, `convex/values`, `convex/react`, …) depends on no internal package ([`package.json`](https://github.com/get-convex/convex-backend/blob/d1770b1a2538c3beed7867e28dc652fdc1b99710/npm-packages/convex/package.json)). It reaches the Rust backend through a JSON syscall ABI ([`syscall.ts`](https://github.com/get-convex/convex-backend/blob/d1770b1a2538c3beed7867e28dc652fdc1b99710/npm-packages/convex/src/server/impl/syscall.ts)). The dashboard's own "system UDFs" are written with `convex/server` and `convex/values`, exactly like user functions ([`listById.ts`](https://github.com/get-convex/convex-backend/blob/d1770b1a2538c3beed7867e28dc652fdc1b99710/npm-packages/system-udfs/convex/_system/frontend/listById.ts)). | The closest match to what the owner wants: the SDK owns the programming model, and the platform's own code is its first user. Only the syscall glue is private (`udf-syscall-ffi`).                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Supabase**              | `@supabase/supabase-js` is an umbrella that depends on and re-exports five sub-clients (`auth-js`, `postgrest-js`, `realtime-js`, `storage-js`, `functions-js`) ([`package.json`](https://github.com/supabase/supabase-js/blob/6d21e3fc8cd5e9cba6b6c30b75a71ffeb97b478d/packages/core/supabase-js/package.json), [`index.ts`](https://github.com/supabase/supabase-js/blob/6d21e3fc8cd5e9cba6b6c30b75a71ffeb97b478d/packages/core/supabase-js/src/index.ts)).                                                                                                                                                                                                                                                                                                                         | A real re-export package, but every sub-client is itself published and useful alone, and the servers (GoTrue, PostgREST, Realtime) are separate projects that share no code with it. The umbrella composes public packages; it does not hide private ones.                                                                                                                                                                                                                                                                                                                               |
| **tRPC**                  | `@trpc/client` peers on `@trpc/server`. The glue between them is published as `@trpc/server/unstable-core-do-not-import`, "to make TypeScript happy and prevent _The inferred type of 'createContext' cannot be named_" ([source](https://github.com/trpc/trpc/blob/8b649ad874a8fe97c73962d4617912231b975736/packages/server/src/unstable-core-do-not-import.ts)).                                                                                                                                                                                                                                                                                                                                                                                                                    | A published package's types must be nameable from published code. Shared internals behind a public package end up published anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Hono**                  | One package, one subpath per module, including a public test helper, `hono/testing` ([source](https://github.com/honojs/hono/blob/57ba76a2a45d0573ed8f1c1e4a9d11dda9c6ab11/src/helper/testing/index.ts)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Precedent for `iterate/stream/test-support`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Wrangler**              | Private workspace packages such as `@cloudflare/workers-shared` are devDependencies bundled into the published CLI ([`wrangler/package.json`](https://github.com/cloudflare/workers-sdk/blob/8d7e3809139cbec3c5b3a54237c1c4edd1cfb5d8/packages/wrangler/package.json), [`workers-shared`](https://github.com/cloudflare/workers-sdk/blob/8d7e3809139cbec3c5b3a54237c1c4edd1cfb5d8/packages/workers-shared/package.json)).                                                                                                                                                                                                                                                                                                                                                             | "Private core, public shell" works for a CLI, whose value is its behavior and not its types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## Why not a private core package re-exported by a thin SDK

- **It would make the two programming models different.** apps/os would import
  `@iterate-com/core/*` and user code `iterate/*`. The platform would stop being the SDK's first
  user, and nothing would notice when a module the platform relies on is missing from the
  public list.
- **The SDK's value is its types.** Re-exporting a private package means bundling its
  declarations into `iterate`'s `.d.ts`, or publishing it after all. tRPC's
  `unstable-core-do-not-import` and Agents' `__DO_NOT_USE_WILL_BREAK__` exports are what that
  looks like. pkg.pr.new publishes `packages/iterate` on every main commit
  (`.github/workflows/pkg-pr-new.yml`), and it can do that because the package "imports nothing
  outside itself".
- **It does not draw the line.** The question moves from "which package does this module live
  in" to "which modules does the facade re-export", and the answer depends on the same thing:
  where the code runs.
- **The repo's own rule** ([jonasland rules](jonasland-rules.md)): "You never want to re-export
  things… No barrel files for stuff that's just imported around the monorepo".

A core package would be the right shape in two cases: several SDK packages that each need the
same internals (Supabase's situation), or a bundled tool with no type surface (Wrangler's).
Revisit this if `@iterate-com/cli`, or a second SDK, starts needing SDK internals that user
code should not see.

## The rule

A module belongs in `iterate` when user code runs it or speaks it: a loaded worker, a facet, a
processor, a browser or Node client, or the wire contract between them and the platform. It
belongs in apps/os when only the platform's Worker runs it. It belongs in packages/shared when
more than one app needs it and user code never does. The SDK and the first-party apps
(`apps/{agents,dash,notes,voice,kit,spa}`, `packages/{cli,ui}`) never import `apps/os/src`; the
`no-restricted-imports` override in `.oxlintrc.json` enforces that.

After this branch, the SDK's subpaths and who imports them:

| Subpath                                                    | What it is                                                                                                           | Runs in                   | Imported by (outside the SDK)        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------ |
| `iterate/sdk`                                              | Facet and processor hosts, `ConfigWorker`, the authoring surface bundled into every loaded isolate as `processor.js` | loaded workers, facets    | agents, notes, os (its own entities) |
| `iterate/stream/processor`                                 | `StreamProcessor`, `ProcessorEngine`, the event envelope, `LiveState`, contracts                                     | facets                    | agents, os                           |
| `iterate/stream/test-support`                              | **new**: the processor harness (`reduceProcessor`, `memoryStream`, `memoryStorage`, `settle`, node:sqlite storage)   | Node tests                | agents, os                           |
| `iterate/stream/run`                                       | Script-run events                                                                                                    | facets, clients           | agents, os, ui                       |
| `iterate/api`                                              | The API's types, as a capnweb client sees them                                                                       | clients                   | agents, dash, os, cli, specs         |
| `iterate/app`, `iterate/app-server`, `iterate/app-session` | A client app's OAuth session and gate pages                                                                          | browser, app Workers      | agents, dash, kit, notes, voice, os  |
| `iterate/client`, `iterate/react`                          | Live state in the browser                                                                                            | browser                   | agents, dash, notes, voice, os       |
| `iterate/node`, `iterate/oauth`                            | Node connection, OAuth client helpers                                                                                | Node                      | cli, os, specs                       |
| `iterate/lib`                                              | Error codes, patches, timeouts, origin and cookie helpers                                                            | everywhere                | agents, dash, kit, cli, os           |
| `iterate/expression`                                       | The expression codec and the dotted surface (`InvokeHandle`)                                                         | clients, the library tier | os                                   |
| `iterate/principal`                                        | `Principal` and `ITX_PRINCIPAL_HEADER`                                                                               | config workers            | os                                   |
| `iterate/oauth-scopes`, `iterate/project-ingress`          | The consent vocabulary; project hostnames                                                                            | clients                   | dash, os, specs                      |

Three subpaths are imported only by apps/os today: `iterate/expression`, `iterate/principal` and
`iterate/oauth-scopes`. They stay public because the other subpaths'
types refer to them (`api.ts` names `InvokeHandle`, `ItxExpressionInput`, `Principal`, the
consent scopes and the ingress routing) and because apps/os's library tier builds its
connectors on the codec and `InvokeHandle`, which is how a user's connector would do it.

## What the branch does

1. **Dispatch moves to apps/os.** `apps/os/src/context/dispatch.ts` (239 lines): the step walk
   (`walkSteps`, `callOn`), the brands registered at boot, `awaitAnswerReleasedIfRejected`, the
   delivery loop's brands (`FacetHandle`, `RpcStubHandle`) and the handle-reference answers
   (`itxAnswerDetachedFromSession`, `materializeItxHandleReference`). `iterate/expression` goes
   from 680 to 465 lines and keeps the codec and the dotted surface. The walk's pipelining
   tests move with it (`context/expression.test.ts` becomes `context/dispatch.test.ts`).
   `itx.facets.get()` is typed as `InvokeHandle`.
2. **The caller moves to apps/os.** `apps/os/src/caller.ts`: `Caller`, `stampCaller`, the
   grant, app and caller-path headers, `signClaims`, `verifyClaims` and `verifyAdminSecret`,
   with their tests. `iterate/principal` goes from 171 to 11 lines. `cookieValueOf` joins
   `iterate/lib`, because the SDK's app gate reads cookies too.
3. **The SDK tests itself.** `iterate/stream/test-support` is new, published and Node-only. The
   engine's two suites now run in packages/iterate. apps/os's processors and apps/agents import
   the harness from the SDK, like any processor author. `apps/os/src/stream/test-support.ts`
   keeps only the real Stream over node:sqlite.
4. **One git protocol implementation.** The GitHub template reader moves to
   `apps/os/src/project/github-template.ts` and speaks git with `apps/os/src/repo/git-wire.ts`,
   which gains the reader's pack size limits, the blobless fetch and multi-prefix ls-refs with
   peeled oids. The shared fork and `pako` in packages/shared are deleted. The template
   reference parser stays in packages/shared, because the dash parses references too.
5. **The rule is linted.** The one exception is `apps/agents/voice/worker.test.ts`, whose fake
   `itx` refuses what the platform's app wall refuses by calling the platform's own
   `admitLoadedCodeRow`. That is a test fake borrowing the real policy, and it carries a
   disable comment that says so.

## Changed published surface

No aliases. Consumers of `iterate` on pkg.pr.new or npm change as follows:

| Before                                                                                                                                                                                                                                                                                  | After                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `iterate/expression`: `registerPipelinedRpcBrand`, `registerRpcSessionBrand`, `walkSteps`, `callOn`, `awaitAnswerReleasedIfRejected`, `FacetHandle`, `RpcStubHandle`, `ITX_HANDLE_REFERENCE_KEY`, `ItxHandleReference`, `itxAnswerDetachedFromSession`, `materializeItxHandleReference` | removed (platform-only, now apps/os) |
| `iterate/principal`: `Caller`, `stampCaller`, `ITX_GRANT_HEADER`, `ITX_APP_HEADER`, `ITX_CALLER_PATH_HEADER`, `signClaims`, `verifyClaims`, `verifyAdminSecret`                                                                                                                         | removed (platform-only, now apps/os) |
| `iterate/principal`: `cookieValueOf`                                                                                                                                                                                                                                                    | `iterate/lib`                        |
| `IterateContextApi["facets"]["get"]` returns `FacetHandle`                                                                                                                                                                                                                              | returns `InvokeHandle`               |
| none                                                                                                                                                                                                                                                                                    | `iterate/stream/test-support`        |

Nothing outside apps/os imported any of the removed names. Decision 8 asked for one version bump
across the SDK's published changes; this belongs in that bump.

## Not in this branch

- **Splitting the event envelope** out of `stream/processor.ts` into its own subpath (A4). It
  would touch about 50 import sites for a file that is already SDK-only, so it is better done
  the next time the envelope changes.
- **A check that every public subpath has a user.** The table above is the check for now.
  `iterate/expression` and `iterate/principal` are the two to watch: if nothing outside apps/os
  needs them within a few months, fold what the other subpaths' types need into `iterate/api`.
