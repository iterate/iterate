# Durable Object Utils

Utilities here are experimental helpers for composing Cloudflare Durable Object classes from small mixins.

## Current Scope

- `mixins/initialize.ts` adds named initialization state for SQLite-backed Durable Objects.
- `mixins/external-listing.ts` best-effort mirrors initialized objects into a D1 table owned by the mixin.
- `mixins/outerbase.ts` and `mixins/kv-inspector.ts` are debug inspector mixins. Do not attach them to production-routed objects without an explicit auth/dev gating decision.
- Avoid adding more mixins or composition helpers without speccing the API shape first.

## Composition Shape

Compose mixins by wrapping the base class, then extend the composed class with
the final worker `Env`:

```ts
type RoomInit = {
  name: string;
  ownerUserId: string;
};

type NeedsListings = {
  DO_LISTINGS: D1Database;
};

type Env = NeedsListings & {
  OTHER_BINDING: Fetcher;
};

const RoomBase = withExternalListing<RoomInit, NeedsListings>({
  className: "Room",
  getDatabase(env) {
    return env.DO_LISTINGS;
  },
})(withInitialize<RoomInit>()(DurableObject));

export class Room extends RoomBase<Env> {}
```

The important invariant is that each mixin returns a generic class value, so the
Cloudflare-style `class Room extends RoomBase<Env>` shape still works after
composition. The type expressions in the mixins are there to preserve that
generic constructor shape and to keep protected members, public members, and
static members visible in the right places.

## Type Shapes

The mixin return types mostly follow this pattern:

```ts
type WithSomeMixinResult<TBase> = TBase & Constructor<MembersAddedByTheMixin>;
```

`TBase` is the important part. If `TBase` is Cloudflare's generic
`DurableObject` class, keeping `TBase` in the return type keeps this valid:

```ts
const Base = withInitialize<RoomInit>()(DurableObject);

export class Room extends Base<Env> {}
```

Without `TBase`, TypeScript would know about the new members but forget that
the returned class is still generic in `Env`.

Some mixins also spell out a generic constructor surface explicitly:

```ts
abstract new <FinalEnv extends NeedsListings>(
  ctx: DurableObjectState,
  env: FinalEnv,
) => DurableObject<FinalEnv> & ExternalListingMembers<RoomInit>
```

That is how `withExternalListing()` keeps the D1 requirement visible without
forcing the final app env to be exactly the small requirement:

```ts
type NeedsListings = {
  DO_LISTINGS: D1Database;
};

type Env = NeedsListings & {
  OTHER_BINDING: Fetcher;
};

const Base = withExternalListing<RoomInit, NeedsListings>({
  className: "Room",
  getDatabase(env) {
    return env.DO_LISTINGS;
  },
})(withInitialize<RoomInit>()(DurableObject));

class Room extends Base<Env> {} // ok: Env has DO_LISTINGS

class Broken extends Base<{ OTHER_BINDING: Fetcher }> {}
// TypeScript error: missing DO_LISTINGS
```

The protected `initParams` type uses an abstract class instead of an interface
because TypeScript interfaces cannot add protected members to a class returned
from a mixin:

```ts
abstract class InitializeProtected<InitParams> {
  protected abstract get initParams(): InitParams;
}
```

That gives subclasses the nice API:

```ts
class Room extends Base<Env> {
  send() {
    return this.initParams.ownerUserId;
  }
}
```

But callers outside the class still get a TypeScript error for
`room.initParams`, so the public API stays explicit:

```ts
await room.initialize(params);
room.assertInitialized();
```

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

Initialization is idempotent for the same object name and same parameter shape.
If a Durable Object already has stored init params, `initialize()` returns those
existing params instead of overwriting them. A different `name`, or different
params for the same name, is treated as a programming error because otherwise
different callers could silently disagree about the identity of the same named
object.

## External Listing

`withExternalListing()` deliberately takes `getDatabase(env)` instead of a
string binding name. That keeps the type story explicit: the call site decides
the minimal `Env` shape that can retrieve D1, and the returned mixin class keeps
that shape as the lower bound for `class Room extends ListedRoomBase<Env>`.

```ts
type NeedsListings = {
  DO_LISTINGS: D1Database;
};

const ListedRoomBase = withExternalListing<RoomInit, NeedsListings>({
  className: "Room",
  getDatabase(env) {
    return env.DO_LISTINGS;
  },
})(withInitialize<RoomInit>()(DurableObject));
```

The D1 write is best-effort and idempotent. The mixin sends
`CREATE TABLE IF NOT EXISTS` in the same D1 batch as each upsert, so object
construction does not block on listing-table setup.

Listing writes happen after `initialize()` via `ctx.waitUntil()`. That is
deliberate: the Durable Object's local initialization remains the source of
truth, and D1 is only a discoverability index. `getExternalListing()` therefore
returns `null` when the object is uninitialized, the background D1 write has not
completed yet, or the listing table does not exist yet. It never uses
`undefined` as the public "missing row" value because `Response.json(undefined)`
throws in Worker runtimes.

The D1 row is keyed by `(class, name)`. `created_at` is the first insert time,
while `last_started_at` is updated on each successful helper acquisition because
`getInitializedDoStub()` always calls `initialize()`. Init params used with this
mixin should be JSON-compatible because the D1 mirror stores them as JSON text.

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

The `unsafe` option is only an acknowledgement at the composition site. It is
not runtime authentication. `/__kv/json` can expose every KV entry in the
object, and `/__outerbase/sql` can execute arbitrary SQL against the object's
SQLite storage.

## Testing

Run the fast local checks from `packages/shared`:

```bash
pnpm test:durable-object-utils
```

`packages/shared` includes this command in its normal `pnpm test` script, so it
runs in the package-level test path used by CI. The deployed-worker e2e harness
is separate because it creates real Cloudflare resources.

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
