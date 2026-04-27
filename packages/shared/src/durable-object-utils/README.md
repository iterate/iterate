# Durable Object Utils

Utilities here are experimental helpers for composing Cloudflare Durable Object classes from small mixins.

## Current Scope

- `mixins/initialize.ts` adds named initialization state for SQLite-backed Durable Objects.
- `mixins/external-listing.ts` best-effort mirrors initialized objects into a D1 table owned by the mixin.
- `mixins/outerbase.ts` and `mixins/kv-inspector.ts` are debug inspector mixins. Do not attach them to production-routed objects without an explicit auth/dev gating decision.
- Avoid adding more mixins or composition helpers without speccing the API shape first.

## Initialization Shape

Use the free helper as the default way to get a named, initialized stub:

```ts
const stub = await getInitializedDoStub({
  namespace: env.ROOMS,
  name: "room-a",
  initParams: {
    ownerUserId: "user-a",
  },
});
```

`getInitializedDoStub()` always calls `initialize()`. If the init shape is only
`{ name: string }`, `initParams` may be omitted and the helper initializes with
`{ name }`. If the init shape has any other fields, TypeScript requires
`initParams` so the helper cannot return an uninitialized stub by accident.

Inside subclasses, use the protected getter:

```ts
class Room extends RoomBase<Env> {
  sendMessage(text: string) {
    const { name, ownerUserId } = this.initParams;
    return { room: name, ownerUserId, text };
  }
}
```

`this.initParams` throws `NotInitializedError` synchronously if initialization
has not happened. External callers cannot access it because it is protected;
their public API is `initialize(params)` and `assertInitialized()`.

## External Listing

`withExternalListing()` deliberately takes `getDatabase(env)` instead of a
string binding name. That keeps the type story explicit: the call site decides
the minimal `Env` shape that can retrieve D1, and the returned mixin class keeps
that shape as the lower bound for `class Room extends ListedRoomBase<Env>`.

```ts
const ListedRoomBase = withExternalListing<RoomInit, Env>({
  className: "Room",
  getDatabase(env) {
    return env.DO_LISTINGS;
  },
})(withInitialize<RoomInit>()(DurableObject));
```

The D1 write is best-effort and idempotent. The mixin sends
`CREATE TABLE IF NOT EXISTS` in the same D1 batch as each upsert, so object
construction does not block on listing-table setup.

## Debug Inspectors

The inspector mixins are intentionally noisy at the call site:

```ts
const InspectorBase = withKvInspector({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
})(
  withOuterbase({
    unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
  })(DurableObject),
);
```

These routes expose storage directly. They are acceptable for local/test
workers and explicitly gated development routes, but they are not safe as a
default production route.

## Testing

Run the fast local checks from `packages/shared`:

```bash
pnpm test:durable-object-utils
```

Run the Cloudflare-backed e2e deployment check only when you need production-runtime coverage:

```bash
doppler run --config <config> -- pnpm test:durable-object-utils:e2e:deploy
```

The deployment script expects Cloudflare and Alchemy variables from the current
environment. Use whichever `_shared` Doppler config should own the deployment,
for example `dev_jonas`, `dev`, or `test`.

## Local Rules

- Keep imports pointed at concrete files or package subpaths; do not add barrel files.
- Keep public exports minimal. Every exported type/function is package API.
- Prefer Cloudflare's mixin shape where possible: a named return surface intersected with the base constructor, like `withVoice(Agent)`.
- Link first-party sources in comments when a Cloudflare or Alchemy behavior is non-obvious.
