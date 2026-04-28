---
name: adding-a-new-durable-object-mixin
description: Add or modify a Durable Object mixin in packages/shared/src/durable-object-utils with the repo's required API design, type documentation, tests, and Cloudflare runtime checks. Use when creating a new withX mixin, changing mixin composition types, or extending the durable-object-utils test harness.
publish: false
---

# Adding A New Durable Object Mixin

Use this before adding or changing a mixin under `packages/shared/src/durable-object-utils`.

The default is **do not code immediately**. First spec the API with the user. If the shape is unclear, use the `grill-me` skill and ask direct design questions until the runtime behavior, type surface, and tests are obvious.

## Ground Rules

- Keep `DurableObject` as the root. Do not add a separate root class, `pipe`, `flow`, or builder unless explicitly specced.
- Prefer nested composition: `withB(withA(withDurableObjectCore(DurableObject)))` when the stack needs local storage, alarms, or lifecycle hooks.
- Preserve Cloudflare-style ergonomics: `const Base = withX(...)(withDurableObjectCore(DurableObject)); class Room extends Base<Env> {}`.
- Keep env requirements and capability requirements separate.
- Use the smallest public API that solves the problem. Do not add optional knobs for hypothetical users.
- Document every non-obvious type expression with the call-site benefit it protects.
- Add examples to `README.md`; `AGENTS.md` in this folder is a symlink to that README, so agents and humans share the same guidance.

## Reference Implementations

- `mixins/with-durable-object-core.ts`: root adapter for Cloudflare's protected `ctx` APIs. It exposes protected local SQLite, synchronous KV, and platform alarm capabilities so feature mixins do not reach into `ctx` directly.
- `mixins/with-lifecycle-hooks.ts`: protected subclass surface, named initialization, first-initialize/start hooks, static/generic preservation through `DurableObjectClass`.
- `mixins/with-d1-object-catalog.ts`: env lower-bound via `getDatabase(env)`, detached/caught best-effort D1 work, D1 tables owned by the mixin, and init-param indexes.
- `mixins/with-multiplexed-alarms.ts`: one owner for Cloudflare's single Durable Object alarm slot, protected scheduling methods, SQLite-backed logical alarm rows.
- `mixins/with-scheduler.ts`: key-based scheduler layered above multiplexed alarms, tagged recurrence rows, split one-shot/recurring failure policy.
- `mixins/with-kv-inspector.ts`: fetch wrapper that preserves generic `Base<Env>`.
- `mixins/with-outerbase.ts`: fetch wrapper around SQLite debug routes.
- `mixins/with-lifecycle-hooks.type.test.ts`: expect-type examples that prove lifecycle, env lower-bound, and alarm protected-surface type incantations still work.
- `test-harness/initialize-fronting-worker.ts`: shared Worker entrypoint for worker-pool unit tests and deployed E2E.
- `README.md`: human/agent docs for composition, type shapes, runtime behavior, and test commands.

## Design Checklist

Before editing, write down:

- What route/RPC/method/state does the mixin add?
- Does it wrap `fetch`, override/extend an existing method, or only add new methods?
- If it overrides `alarm`, `fetch`, or another runtime hook, does it call the inherited implementation and document what subclasses above it must do?
- Does it require env bindings? If yes, what is the minimum env shape?
- Does it require members from earlier mixins? If yes, what exact capability interface should the base satisfy?
- Does it need local SQLite, synchronous KV, or platform alarms? If yes, depend on `DurableObjectCoreProtected` from `withDurableObjectCore()` instead of reaching into `ctx` directly.
- Is any work best-effort? If yes, start a detached promise, catch/log failures, and document that Cloudflare's Durable Object `ctx.waitUntil()` has no Worker-style lifetime effect.
- What should happen if a caller uses the mixin in production by accident?

If any answer is fuzzy, stop and grill the user. Do not encode uncertainty as optional config.

## Type Pattern

Name each mixin implementation file after the mixin function in kebab-case:
`with-thing.ts` for `withThing()`.

For a simple member-adding mixin with no new env requirement, use the Cloudflare `withVoice` style:

```ts
type WithThingResult<TBase extends DurableObjectConstructor> = TBase & Constructor<ThingMembers>;
```

`TBase` preserves the original class value, including statics and the generic `Base<Env>` shape. `Constructor<ThingMembers>` adds the instance methods.

For a mixin that must preserve accumulated env requirements and members through multiple wrappers, use the explicit generic Durable Object constructor pattern:

```ts
type DurableObjectClass<ReqEnv = unknown, Members = object> = abstract new <Env extends ReqEnv>(
  ctx: DurableObjectState,
  env: Env,
) => DurableObject<Env> & Members;
```

Use comments to explain:

- `ReqEnv` is the minimum env shape required by mixins applied so far.
- `Members` is the instance surface accumulated so far.
- The purpose is to keep `class Room extends Base<Env>` valid after composition.

Feature mixins should generally consume protected capabilities from lower layers
instead of touching Cloudflare `ctx` directly. For example, `withScheduler()`
uses `withMultiplexedAlarms()` and `withDurableObjectCore()`, while
`withDurableObjectCore()` is the only reusable layer that adapts
`ctx.storage.sql`, `ctx.storage.kv`, and platform alarms.

When a mixin needs one storage operation, prefer the scoped callback helpers:

```ts
return this.useDurableObjectKv((kv) => Response.json(readKvEntries(kv)));
```

Only use the raw protected storage handles when the mixin owns durable state and
needs several related operations in one method. This keeps debug/fetch helpers
from passing raw Cloudflare storage handles through unrelated rendering code.

For env bindings, prefer a lower-bound type selected by the call site:

```ts
type NeedsCatalog = {
  DO_CATALOG: D1Database;
};

const Base = withD1ObjectCatalog<RoomInit, NeedsCatalog>({
  className: "Room",
  getDatabase(env) {
    return env.DO_CATALOG;
  },
})(withLifecycleHooks<RoomInit>()(withDurableObjectCore(DurableObject)));

class Room extends Base<NeedsCatalog & { OTHER: string }> {}
```

Avoid app-wide `Env` in the library if a smaller binding fragment is enough.

## Documentation Requirements

Every mixin needs:

- A top-level JSDoc saying what it adds and what routes/methods it owns.
- A clear warning if it exposes storage, SQL, debug state, or unsafe behavior.
- Comments beside type aliases when preserving `TBase`, `ReqEnv`, `Members`, protected members, or env lower-bounds.
- README examples showing the call-site benefit, not just implementation details.
- A note explaining any detached promises, synchronous KV, SQLite, D1, or Alchemy behavior that is not obvious.

Do not write “magic” comments. Prefer:

```ts
// Preserve Base<Env> so this remains legal:
// class Room extends MixedBase<Env> {}
```

over:

```ts
// Type-level plumbing.
```

## Tests

Add or update all relevant levels:

- Type tests: `mixins/*.type.test.ts` using Vitest `expectTypeOf`.
- Unit tests: worker-pool Vitest tests using `cloudflare:test`.
- E2E tests: fronting Worker tests when runtime behavior depends on real Worker/DO/D1 behavior.

Type tests should read as examples:

- composed base can still be extended as `Base<Env>`;
- members from earlier mixins survive later mixins;
- env lower-bounds reject missing bindings;
- protected members are visible in subclasses and hidden from callers;
- helper options are required/optional exactly when intended.

Run before handing off:

```bash
pnpm --dir packages/shared typecheck
pnpm --dir packages/shared test:durable-object-utils
pnpm exec oxlint packages/shared/src/durable-object-utils --threads 1 --deny-warnings
```

For production-runtime coverage:

```bash
cd packages/shared
doppler run --config dev_jonas -- pnpm test:durable-object-utils:e2e:deploy
```

## PR Hygiene

- Keep `packages/shared/src/durable-object-utils/AGENTS.md` symlinked to `README.md`.
- Do not add barrel files unless explicitly requested.
- Keep relative imports explicit with `.ts`.
- Avoid `as any`; if a cast is unavoidable, keep it local and explain the exact runtime fact that makes it safe.
- If a review comment says the type surface is unclear, add a focused example instead of adding more abstractions.
