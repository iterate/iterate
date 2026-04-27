# Durable Object Utils Review

Scope: current unstaged changes for `packages/shared/src/durable-object-utils`, `packages/shared/package.json`, `doppler.yaml`, and the related lockfile/typecheck changes.

## Executive Summary

The `withInitialize` generic-class ergonomics broadly match Cloudflare's local `withVoice(Agent)` pattern, but the implementation still has several correctness and API-safety problems. The biggest issues are the unauthenticated inspector mixins being exported as public package API, the loose `Constructor` constraints followed by `unknown` casts to Durable Object internals, and `JSON.stringify` idempotency causing false initialization conflicts.

The implementation has been tested with type-only tests, worker-pool unit tests, and deployed-worker e2e runs. The e2e path is intentionally not part of the default package test script because it creates Cloudflare resources.

## Findings

### High: inspector mixins expose unauthenticated storage access

`withKvInspector` exposes all Durable Object KV contents at `/__kv/json`, and `withOuterbase` exposes arbitrary SQL execution at `/__outerbase/sql`. Both are exported from `packages/shared/package.json`.

This is not safe as a production-default public API. If a DO using either mixin is reachable through routing, the endpoints can leak or mutate all attached storage.

Options:

- A. Recommended: make both inspector mixins internal/test-only until we spec an auth/dev gating shape.
- B. Require explicit options, for example `withOuterbase({ requireToken })`, and fail closed unless configured.
- C. Keep public exports but document them as unsafe debug tools. This is the weakest option.

### High: mixins accept arbitrary constructors but assume Durable Object internals

`withInitialize`, `withKvInspector`, and `withOuterbase` accept a generic `Constructor`, then cast through `unknown` to access `ctx`.

This means `withInitialize<Init>()(class NotDurableObject {})` can typecheck and fail at runtime. It also violates the repo preference for explicit dependencies over hidden globals/casts.

Options:

- A. Recommended: constrain bases to a Durable Object constructor shape that exposes `ctx`.
- B. Use a typed adapter/options dependency to retrieve `ctx`.
- C. Keep casts and rely on tests. This is not acceptable for library code.

### High: `JSON.stringify` equality breaks idempotent initialization

At review time, idempotency compared init params with `JSON.stringify`. Equivalent objects with different key insertion order could mismatch. One concrete case: direct `initialize({ name, ownerUserId })` then factory initialization with `{ ownerUserId }` could store/normalize key order differently and throw `InitializeParamsMismatchError`.

Options:

- A. Recommended: use a stable canonical serializer for structured-clone-safe values.
- B. Store only once and allow later same-name initialization without comparing non-name fields.
- C. Require the caller to provide an equality function. This is too much API for the first mixin.

### High: `withInitialize` is now SQLite-backed only

Using `ctx.storage.kv` is correct for new SQLite-backed DOs and removes the need for `blockConcurrencyWhile`, but it silently excludes legacy KV-backed Durable Objects.

Options:

- A. Recommended: document and name this as SQLite-backed DO only, since the repo's new DO classes should use SQLite.
- B. Go back to async top-level `ctx.storage.get/put` for legacy compatibility.
- C. Support both with runtime branching. This adds complexity and should not be done without a concrete need.

### Medium: static `getByName` was not tied to the calling class identity

At review time, `Room.getByName(otherNamespaceWithSameInitParams, ...)` could typecheck because the namespace was generic over any instance with matching initialize members. The static was useful, but this shape did not prove the namespace belonged to the class the static was called on.

Options:

- A. Recommended: prefer a free `getInitializedDoStub({ namespace, name, initParams })` helper, matching Cloudflare Agents' free-helper convention while keeping arguments explicit.
- B. Keep static sugar but document that the namespace argument is authoritative.
- C. Try to bind static `this` to namespace instance identity. This may make types much more complex.

### Medium: `InitializeInput` is not distributive over union init params

The current `Omit<InitParams, "name"> & Partial<Pick<...>>` shape can weaken discriminated unions and allow missing variant fields.

Options:

- A. Recommended: make `InitializeInput` distributive.
- B. Document that init params should be a single object shape, not a union.

### Medium: deployed e2e is separate from default package tests

`pnpm --dir packages/shared test` runs type-only and worker-pool unit tests, but not deployed-worker e2e. That is reasonable for speed/cost, but the README should make this distinction explicit.

Options:

- A. Recommended: keep e2e manual/CI-explicit and document it clearly.
- B. Add e2e deployment to default `test`. This is too slow and Cloudflare-dependent for a package test script.

### Medium: e2e deployment was hard-coded to `dev_jonas`

At review time, the runner invoked `doppler run --config dev_jonas` internally. The runner now expects environment variables to be provided by the caller, so the caller chooses `doppler run --config <config>`.

Options:

- A. Recommended: default to ambient Doppler config and allow `DOPPLER_CONFIG=dev_jonas`.
- B. Keep `dev_jonas` as a local convenience script only and name it accordingly.

### Medium: public export surface is too broad

The initialize module exports scaffolding types like `InitializeProtected`, `InitializeStatic`, and `WithInitializeResult`. These are implementation artifacts unless consumers need to name them.

Options:

- A. Recommended: export only `withInitialize`, `InitializeInput`, intended member type(s), and public errors.
- B. Keep type exports for now because declaration users may need them. This increases API surface.

### Medium: docs and local agent instructions are incomplete

At review time there was only an e2e README. This has since been partially remediated with a durable-object-utils root README and an `AGENTS.md -> README.md` symlink, but the README still needs to be updated after the API/security decisions below.

Options:

- A. Recommended: add a root `README.md` for package-local conventions and symlink `AGENTS.md -> README.md`.
- B. Only document e2e. This misses the public API and safety context.

### Low: Outerbase page path breaks behind prefixed fronting routes

The embedded page posts to `/__outerbase/sql`, but the e2e fronting worker mounts it under `/inspectors/:name/__outerbase`. The direct SQL e2e still passes because it does not exercise browser postMessage flow.

Options:

- A. Recommended: post to a URL relative to the current page path.
- B. Keep the page only for root-mounted DO fetch. This should be documented and tested.

### Low: multi-statement Outerbase requests are not transactional

`statements` are executed one by one. If the caller sends a transaction-like message and a later statement fails, earlier writes may already be committed.

Options:

- A. Recommended: wrap multi-statement execution in `ctx.storage.transactionSync`.
- B. Rename the field to `statements` and explicitly avoid transaction semantics.

### Low: KV inspector reads everything into memory

`ctx.storage.kv.list()` is materialized without pagination or limits, and JSON serialization can fail on some structured-clone values.

Options:

- A. Recommended: add a small default limit and explicit serialization.
- B. Keep it tiny/debug-only, but then it should not be public production API.

## Positive Findings

- The generic class return shape is close to Cloudflare's `withVoice` pattern: `TBase & Constructor<Members>`.
- The protected `initParams` type trick is working in type tests.
- Worker-pool unit tests and deployed-worker e2e did run successfully after the synchronous KV correction.
- There are no barrel files or re-export files in the new durable-object-utils folder.

## Plan (TODO)

- Keep `withOuterbase` and `withKvInspector` exported, but document them as debug-only tools that must be gated before production routing.
- Replace static `InitializeTestRoom.getByName(...)` API with free `getInitializedDoStub({ namespace, name, initParams })`; the namespace is the source of truth and the types stay simple.
- Keep the Cloudflare-style returned generic class value for `withInitialize`, preserving `class Room extends RoomBase<Env>`.
- Encode the SQLite-backed Durable Object requirement in comments/docs because `ctx.storage.kv` is the synchronous API being used.
- Replace `JSON.stringify` idempotency with order-insensitive deep equality and cover direct-init then helper-init in unit tests.
- Add a negative type test that non-DurableObject bases are rejected.
- Make the e2e deployment runner assume it is already inside `doppler run`; callers choose the config with `doppler run --config <config> -- pnpm ...`.
- Add root `README.md` and `AGENTS.md -> README.md` symlink for the durable-object-utils folder.
