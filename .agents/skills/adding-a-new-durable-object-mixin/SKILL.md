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
- Prefer nested composition: `withB(withA(DurableObject))`.
- Preserve Cloudflare-style ergonomics: `const Base = withX(...)(DurableObject); class Room extends Base<Env> {}`.
- Keep env requirements and capability requirements separate.
- Use the smallest public API that solves the problem. Do not add optional knobs for hypothetical users.
- Document every non-obvious type expression with the call-site benefit it protects.
- Add examples to `README.md`; `AGENTS.md` in this folder is a symlink to that README, so agents and humans share the same guidance.

## Reference Implementations

- `mixins/with-initialize.ts`: protected subclass surface, named initialization, static/generic preservation in the simple `TBase & Constructor<Members>` shape.
- `mixins/with-external-listing.ts`: env lower-bound via `getDatabase(env)`, best-effort `ctx.waitUntil()` work, D1 table owned by the mixin.
- `mixins/with-kv-inspector.ts`: fetch wrapper that preserves generic `Base<Env>`.
- `mixins/with-outerbase.ts`: fetch wrapper around SQLite debug routes.
- `mixins/with-initialize.type.test.ts`: expect-type examples that prove the type incantations still work.
- `test-harness/initialize-fronting-worker.ts`: shared Worker entrypoint for worker-pool unit tests and deployed E2E.
- `README.md`: human/agent docs for composition, type shapes, runtime behavior, and test commands.

## Design Checklist

Before editing, write down:

- What route/RPC/method/state does the mixin add?
- Does it wrap `fetch`, override/extend an existing method, or only add new methods?
- Does it require env bindings? If yes, what is the minimum env shape?
- Does it require members from earlier mixins? If yes, what exact capability interface should the base satisfy?
- Does it use SQLite `ctx.storage.sql` or synchronous `ctx.storage.kv`? If yes, document that it requires SQLite-backed DOs.
- Is any work best-effort? If yes, use `ctx.waitUntil()` and make failure logging explicit.
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

For env bindings, prefer a lower-bound type selected by the call site:

```ts
type NeedsListings = {
  DO_LISTINGS: D1Database;
};

const Base = withExternalListing<RoomInit, NeedsListings>({
  className: "Room",
  getDatabase(env) {
    return env.DO_LISTINGS;
  },
})(withInitialize<RoomInit>()(DurableObject));

class Room extends Base<NeedsListings & { OTHER: string }> {}
```

Avoid app-wide `Env` in the library if a smaller binding fragment is enough.

## Documentation Requirements

Every mixin needs:

- A top-level JSDoc saying what it adds and what routes/methods it owns.
- A clear warning if it exposes storage, SQL, debug state, or unsafe behavior.
- Comments beside type aliases when preserving `TBase`, `ReqEnv`, `Members`, protected members, or env lower-bounds.
- README examples showing the call-site benefit, not just implementation details.
- A note explaining any `ctx.waitUntil()`, synchronous KV, SQLite, D1, or Alchemy behavior that is not obvious.

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
