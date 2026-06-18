---
state: todo
priority: high
size: large
tags: [itx, reference-implementation, cleanup, type-safety]
---

# Clean up the minimal ITX reference implementation after review

The review found that the reference implementation is now featureful enough to
prove the model, but it has accumulated unclear helper names, broad `any` casts,
duplicated host plumbing, stale comments, and test-layout drift. This task is a
cleanup pass, not a redesign of ITX.

## Goals

- Keep the current public API and all current e2e behaviour.
- Keep the project/agent/repo/stream domain-object layout.
- Make the reference implementation easier to read than apps/os, not a second
  production framework.
- Remove unsafe casts by typing the few sources that force them downstream.
- Remove single-use wrappers and speculative types unless they genuinely name a
  repeated boundary.
- Keep comments only where they explain non-obvious runtime or RPC lifecycle
  behaviour.

## Non-goals

- Do not change production apps/os ITX behaviour in this task.
- Do not add security policy work beyond preserving existing denial tests.
- Do not rename the public `/api/itx` endpoint or client functions.
- Do not reintroduce abstract base classes for project/agent hosts.

## Guardrails

- Regression-first for behavioural fixes. If a change fixes a bug rather than
  pure cleanup, add or tighten a failing test first.
- Keep `src/itx/processor.ts` small and boring; avoid new layers around the
  processor.
- Prefer inlining over helpers when a helper only hides one call site.
- Use bag-of-props for shared internal helpers that carry several values.
- Run at minimum:
  - `pnpm --dir apps/minimal-itx-reference-implementation typecheck`
  - `pnpm --dir apps/minimal-itx-reference-implementation exec vitest run src/itx/path-invoker.test.ts --project node`
  - local worker e2e against `ITX_BASE=http://localhost:8788`

## Phase 1: Type the roots of the `any` spread

The review's biggest issue is not isolated casts; it is a few untyped roots that
force casts everywhere else.

- Type `#stream()` in `ProjectDurableObject` and `AgentDurableObject`.
  - Return the concrete append/appendBatch shape needed by `ItxProcessor`.
  - Remove downstream `(committed as any).offset`, `as any` append payloads, and
    `(args: any)` closures.
- Type worker env access in RPC targets.
  - Avoid repeated `workerEnv as unknown as Env`.
  - If Cloudflare's global `env` cannot be typed directly, make one local,
    plainly named cast boundary and use it consistently.
- Export/consume concrete test-facing result types.
  - `describe()` result should not require `(c: any)` in tests.
  - `runScript()` and response JSON helpers should have small local result
    types where tests inspect them.
- Replace `<T = any>` defaults in client/test helpers.
  - Use `unknown` or a narrow default.
  - Let call sites opt into `any` only where they are intentionally testing a
    dynamic surface.
- Type the remaining shared low-level helpers.
  - `retain`, `replayPath`, `disposeLiveValue`, `pathInvokerToProxy`,
    `localPathProxy`, `RootEnv.getByName`, `LOADER`, and `STREAM`.
  - Prefer `unknown` plus narrowing over `any`.

Acceptance criteria:

- `rg "as any|: any|<T = any>|unknown as Env" apps/minimal-itx-reference-implementation/src apps/minimal-itx-reference-implementation/*.test.ts`
  returns only documented, intentional exceptions.
- No test assertions need `(x: any)` for normal `describe()` or script results.

## Phase 2: Consolidate duplicated ITX host plumbing

`ProjectDurableObject` and `AgentDurableObject` duplicate the same host concerns:
dynamic worker resolution, dynamic DO facet resolution, script execution, and
stream append access. The repo DO does not need this machinery, which confirms
it is ITX-host plumbing rather than generic domain-object plumbing.

- Extract one small host primitive, probably a function or object factory, not
  an abstract base class.
  - Inputs: `ctx`, `env`, parsed durable object name, host stream, repo path,
    and `invokeCapability`.
  - Outputs: `resolveDynamicCapability`, `runScript`, and source resolution.
- Keep project/agent classes readable.
  - Their top-level shape should still show `name`, `host`, domain processor,
    `itxProcessor`, and domain-specific public methods.
- Deduplicate:
  - `#resolveDynamicCapability`
  - `#resolveWorkerSource`
  - `#loadResolvedDynamicWorker`
  - `#loadDynamicWorker`
  - `#runScript`
  - `#stream`
- Keep the generated script source easy to inspect.
  - Dedent the template string or move the source builder into the shared host
    primitive if that is clearer.

Acceptance criteria:

- Project and agent still inline their domain-specific behaviour.
- The shared primitive is smaller than the duplicated code it removes.
- No abstract base class is introduced.

## Phase 3: Remove single-use helpers and speculative vocabulary

Delete helpers that obscure more than they explain.

- Inline or rename helper-shaped assertions:
  - `normalizeAgentPath` should become an inline assertion or be renamed if it
    remains.
  - `RepoRpcTarget.#repo` should disappear if it is one call.
  - `readScriptCode` and `json` in `worker.ts` should stay only if they remain
    meaningful after simplifying POST handling.
- Remove speculative or empty example abstractions:
  - `ALL_RUNTIMES` / `runtimes` if every example runs everywhere.
  - `ExampleRunContext` if fields are unused.
  - `EXAMPLE_IDS_WITHOUT_CASES` if it is empty and proves nothing.
  - `slug` and dispatch helpers if they only wrap one expression.
- Tighten auth helpers.
  - Use one failure convention: either `null` or a discriminated result, not
    both.
  - Use `satisfies` for `PRINCIPALS` so literal keys are preserved.
- Remove defensive fallbacks that hide invalid construction.
  - `ItxProcessor` should require its dynamic resolver/script runner when the
    host needs those features, rather than installing throwing defaults.
  - Schema-validated event payloads should not be revalidated with silent
    guards unless the stream contract truly admits invalid data.

Acceptance criteria:

- Helpers kept in the codebase name repeated concepts or non-obvious runtime
  boundaries.
- No top-level helper exists solely to wrap one call with no domain meaning.

## Phase 4: Centralize constants and contracts that can drift

- Collapse reserved-name sets.
  - `INVALID_PATH_SEGMENTS` and path proxy reserved names should either share a
    source or be explicitly split with comments explaining why.
- Deduplicate event contract arrays.
  - `consumes` and `emits` in `processor-contract.ts` should not be identical
    copy-paste lists if one can be derived or named once.
- Define `PROJECT_REPO_PATH` once.
  - Use it in project DO, agent DO, and project processor.
- Centralize base URL/test runtime defaults.
  - `http://127.0.0.1:8788` and `ITX_BASE || APP_CONFIG_BASE_URL || default`
    should not be reimplemented with subtly different trimming.
- Remove stale deleted-file references.
  - `server.ts` comments are stale.
  - Use `pnpm`, not `npm`, in comments and docs for this app.

Acceptance criteria:

- `rg "server.ts|npm run dev|127.0.0.1:8788|PROJECT_REPO_PATH|INVALID_PATH_SEGMENTS|RESERVED"`
  has only intentional, centralized occurrences.

## Phase 5: Fix the dynamic durable object `mountPath` bug

The review found a likely real bug: dynamic durable object facet naming reads
`mountPath` from a cast even though `CapabilityAddress` does not contain that
field. If the code currently relies on host-owned mount path identity, the
contract and resolution path need to say that explicitly.

Regression test first:

- Provide the same dynamic durable object class at two different capability
  paths.
- Increment both.
- Assert their storage is isolated by mounted path.
- Re-provide the same capability at the same path with upgraded source.
- Assert storage survives source upgrades at that path.

Then choose the explicit model:

- Option A: `mountPath` remains host-owned metadata.
  - Do not put it in provider-supplied `CapabilityAddress`.
  - Thread it in a typed internal `ResolvedDynamicDurableObjectAddress`.
- Option B: `mountPath` is part of the durable address contract.
  - Add it to the internal schema only if provider code is not allowed to
    supply it.

Acceptance criteria:

- No `address as { mountPath?: ... }` cast remains.
- Facet identity tests prove mount-path isolation and upgrade survival.

## Phase 6: Simplify file-specific hot spots

### `src/itx/processor.ts`

- Cut comment essays and editorial emphasis.
- Keep comments for:
  - live stub retention/disposal,
  - Cap'n Web path replay receiver binding,
  - dynamic DO mount identity.
- Remove redundant `?? null` if the schema already defaults.
- Revisit `LiveRpcStub`/retention naming after Phase 1 types are clearer.

### `src/itx/root.ts`

- Shorten the header to the actual invariant: admin-only platform root,
  project catalog, `__global__`/platform streams.
- Avoid rebuilding large dispatch objects if direct branches read better.
- Remove redundant `async`/`await` where it adds nothing.

### `src/itx/path-invoker.ts`

- Keep `objectToPathInvoker` and `pathInvokerToProxy` only if their inverse
  relationship remains obvious and unit-tested.
- Ensure `replayPath({ target, path, args })` is the only shared replay helper
  shape.

### `src/domains/streams/streams-rpc-target.ts`

- Keep a local `StreamRpcTarget`.
- Document only the one non-obvious branch: `subscribe()` must retain callbacks
  after the subscribe RPC returns.
- Do not import apps/os's generated `StreamRpcTarget`.

### `src/client.ts`

- Make required fields required in `WithItxInput` / `WithRootInput` if comments
  say they are required.
- Delete `itxHttpUrl` if no longer used.
- Move or inline `sleep` if it is test-only.
- Avoid proxy traps that shadow the target in confusing ways.

### `src/env.ts` and `env.d.ts`

- Pick one source of truth for `Env` navigation.
- Type `STREAM` and `LOADER` enough that app code does not need local `any`
  casts.

Acceptance criteria:

- Each file's top-level exports map cleanly to a domain concept or runtime
  boundary.
- Comments explain why, not what.

## Phase 7: Test layout and test quality cleanup

- Move app e2e/browser tests under the repo's expected app test layout if that
  convention applies to this app:
  - `apps/minimal-itx-reference-implementation/e2e/**`
  - update `vitest.config.ts` accordingly.
- Remove numeric test prefixes or renumber without gaps.
- Split mega-tests that assert multiple unrelated contracts.
- Replace flaky sleeps.
  - Use `vi.waitFor`, `expect.poll`, or stream `waitUntilEvent`.
- Tighten assertions.
  - Avoid matcher-less `.toThrow()`.
  - Avoid truthiness-only assertions where shape matters.
  - Remove tautological harness tests unless they protect a real contract.
- Deduplicate test helpers:
  - `expectRejects`
  - `rid`
  - `agentItx`
  - `AsyncFunction`
  - cross-project deny cases
- Fix hidden failure paths.
  - Remove empty `catch {}` blocks that hide upgrade rejection regressions.

Acceptance criteria:

- Test names describe behaviour, not sequence numbers.
- A failing denial test explains which denial failed.
- The suite still passes in node, browser, CLI/script, and worker runtime paths.

## Phase 8: Docs and design cleanup

- Update `README.md` and `DESIGN.md` after code cleanup, not before.
- Remove stale references to:
  - deleted `server.ts`,
  - old `ItxContext` name,
  - old file paths after the domain layout refactor.
- Keep the design doc focused on:
  - the two connect doors,
  - project/agent ownership,
  - dynamic worker loading,
  - dynamic durable object facets,
  - live capability retention,
  - stream handles and why `subscribe()` is special.
- Do not document transient helper names.

Acceptance criteria:

- A new reader can follow the reference implementation from `src/worker.ts` to
  project/agent/repo/stream domains without stale names.
- The docs describe what is intentionally simple and what is intentionally
  copied from apps/os runtime behaviour.

## Suggested execution order

1. Phase 1 type roots.
2. Phase 5 `mountPath` regression and fix, because it may be real behaviour.
3. Phase 2 host plumbing extraction.
4. Phase 4 constants/contracts.
5. Phase 3 helper/speculation cleanup.
6. Phase 6 file hot spots.
7. Phase 7 tests.
8. Phase 8 docs.

This order keeps behaviour protected while reducing the largest sources of
noise first. It also avoids spending time polishing comments and tests around
code that will be deleted by the type and host-plumbing passes.
