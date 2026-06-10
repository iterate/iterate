# Durable Object Utils

Utilities here are experimental helpers for composing Cloudflare Durable Object classes from small mixins.

## Current Scope

- `mixins/with-durable-object-core.ts` is the root adapter for mixins that need Cloudflare's protected Durable Object `ctx` APIs. It exposes small protected capabilities for local SQLite, synchronous KV, and the single platform alarm slot.
- `mixins/with-lifecycle-hooks.ts` adds reliable named initialization state, tiny lifecycle hooks, and an explicit `d1ObjectCatalog` setting for best-effort D1 catalog projection.
- `mixins/with-outerbase.ts` and `mixins/with-kv-inspector.ts` are debug inspector mixins. Do not attach them to production-routed objects without an explicit auth/dev gating decision.
- `iterate-durable-object.ts` composes the default stack for application-owned Durable Objects: `withIterateDurableObjectStack(options)` layers core, lifecycle hooks with a D1 object catalog, and both debug inspectors; `createIterateDurableObjectBase(options)` applies that stack to `DurableObject`.
- Avoid adding more mixins or composition helpers without speccing the API shape first.

## Composition Shape

Compose mixins by wrapping the base class, then extend the composed class with
the final worker `Env`:

```ts
const RoomStructuredName = z.object({
  ownerUserId: z.string(),
});

type RoomStructuredName = z.infer<typeof RoomStructuredName>;

type NeedsCatalog = {
  DO_CATALOG: D1Database;
};

type Env = NeedsCatalog & {
  OTHER_BINDING: Fetcher;
};

const RoomBase = withLifecycleHooks<RoomStructuredName, undefined, NeedsCatalog>({
  d1ObjectCatalog: {
    className: "Room",
    getDatabase(env) {
      return env.DO_CATALOG;
    },
    indexes: {
      ownerUserId(params) {
        return params.ownerUserId;
      },
    },
  },
  nameSchema: RoomStructuredName,
})(withDurableObjectCore(DurableObject));

export class Room extends RoomBase<Env> {}
```

The important invariant is that each mixin returns a generic class value, so the
Cloudflare-style `class Room extends RoomBase<Env>` shape still works after
composition. The type expressions in the mixins are there to preserve that
generic constructor shape and to keep protected members, public members, and
static members visible in the right places.

## Type Shapes

The bottom of most stacks should be `withDurableObjectCore(DurableObject)`.
That core layer is intentionally tiny: it is the one reusable place where our
mixins adapt Cloudflare's protected `ctx.storage` and alarm APIs into protected
capabilities. Higher mixins consume those capabilities, similar to how the
Cloudflare Agents SDK exposes `Agent.sql()` and `withVoice()` consumes `sql`
instead of reaching into `ctx.storage.sql` itself.

Core exposes both scoped callback helpers and raw protected handles. Prefer the
callback helpers for one-off access:

```ts
return this.useDurableObjectKv((kv) => Response.json(readKvEntries(kv)));
```

That keeps storage access inside the mixin method and lets plain helper
functions operate on plain data. Use the raw protected handles only when a mixin
owns durable schema/state and needs several related storage operations in one
method.

Simple mixin return types mostly follow this pattern:

```ts
type WithSomeMixinResult<TBase> = TBase & Constructor<MembersAddedByTheMixin>;
```

`TBase` is the important part. If `TBase` is Cloudflare's generic
`DurableObject` class, keeping `TBase` in the return type keeps this valid:

```ts
const Base = withLifecycleHooks({ d1ObjectCatalog: "none", nameSchema: RoomInit })(
  withDurableObjectCore(DurableObject),
);

export class Room extends Base<Env> {}
```

Without `TBase`, TypeScript would know about the new members but forget that
the returned class is still generic in `Env`.

Some mixin options also spell out a generic constructor surface explicitly:

```ts
abstract new <FinalEnv extends NeedsCatalog>(
  ctx: DurableObjectState,
  env: FinalEnv,
) => DurableObject<FinalEnv> & LifecycleHooksMembers<RoomInit>
```

That is how lifecycle `d1ObjectCatalog` keeps the D1 requirement visible without
forcing the final app env to be exactly the small requirement:

```ts
type NeedsCatalog = {
  DO_CATALOG: D1Database;
};

type Env = NeedsCatalog & {
  OTHER_BINDING: Fetcher;
};

const Base = withLifecycleHooks<RoomInit, undefined, NeedsCatalog>({
  d1ObjectCatalog: {
    className: "Room",
    getDatabase(env) {
      return env.DO_CATALOG;
    },
  },
  nameSchema: RoomInit,
})(withDurableObjectCore(DurableObject));

class Room extends Base<Env> {} // ok: Env has DO_CATALOG

class Broken extends Base<{ OTHER_BINDING: Fetcher }> {}
// TypeScript error: missing DO_CATALOG
```

The protected `structuredName` type uses an abstract class instead of an interface
because TypeScript interfaces cannot add protected members to a class returned
from a mixin:

```ts
abstract class LifecycleHooksProtected<StructuredName> {
  protected abstract get structuredName(): StructuredName;
}
```

That gives subclasses the nice API:

```ts
class Room extends Base<Env> {
  send() {
    return this.structuredName.ownerUserId;
  }
}
```

But callers outside the class still get a TypeScript error for
`room.structuredName`, so the public API stays explicit:

```ts
await room.initialize({ name: '{"ownerUserId":"user-a"}' });
await room.ensureStarted();
room.assertInitialized();
```

## Lifecycle Names

Cloudflare Durable Objects are primarily named by strings. That remains the
base model here: use `namespace.getByName(name)` when you only need a stub, and
use `getInitializedDoStub({ allowCreate, name })` when the object also uses
lifecycle hooks:

```ts
const stub = await getInitializedDoStub({
  allowCreate: true,
  namespace: env.ROOMS,
  name: "room-a",
});
```

Inside our mixin-based Durable Objects, `this.name` is the reliable string name.
It is populated from `initialize({ name })`, stored in Durable Object storage,
and rehydrated synchronously during construction. This exists because
`ctx.id.name` is not reliable in Miniflare, and alarm wakes do not pass through
a caller-side wrapper. If initialization has not happened yet, `this.name`
throws `NotInitializedError` instead of returning a vague fallback.

Names are Durable Object identity, so build them from stable identifiers. Prefer
database IDs, project IDs, user IDs, or another immutable key. Avoid slugs,
titles, and other mutable labels unless changing that label should intentionally
create a different Durable Object.

Some Durable Object names are really a stable tuple, such as
`{ projectId, streamPath }`. In that case configure `withLifecycleHooks()` with
a Zod `nameSchema`, then pass the tuple as the helper's `name`; the helper
derives the deterministic string name and initializes the object with that raw
name:

```ts
const stub = await getInitializedDoStub({
  allowCreate: true,
  namespace: env.CODEMODE_SESSIONS,
  name: {
    projectId: "proj_123",
    streamPath: "/codemode/session-a",
  },
});
```

The generated name is still the Cloudflare identity:

```ts
const name = deriveDurableObjectNameFromStructuredName({
  structuredName: { projectId: "proj_123", streamPath: "/codemode/session-a" },
});

const stub = env.CODEMODE_SESSIONS.getByName(name);
await stub.initialize({
  name,
});
```

If a name starts with `{`, the mixin tries to JSON-parse it and then feeds the
result to the configured Zod schema. If JSON parsing fails, or the name does not
start with `{`, the raw string is passed to the schema. With no schema,
`withLifecycleHooks()` defaults to `z.string()`, so ordinary string-name Durable
Objects stay simple.

When a Durable Object also needs immutable creation-time data that should not be
part of its name, configure `initialStateSchema`. This is deliberately separate
from `nameSchema`: a structured name means the name itself contains the typed
identity, while initial state means the first valid initialization must provide
extra immutable data.

```ts
const SessionInitialState = z.object({
  projectId: z.string(),
  userId: z.string(),
  streamPath: StreamPath,
});

const SessionBase = withLifecycleHooks({
  d1ObjectCatalog: "none",
  initialStateSchema: SessionInitialState,
})(withDurableObjectCore(DurableObject));

const session = await getInitializedDoStub({
  allowCreate: true,
  namespace: env.SESSIONS,
  name: sessionId,
  initialState: {
    projectId,
    userId,
    streamPath,
  },
});
```

After first initialization, the object hydrates `this.initialState` from Durable
Object storage. Later callers may initialize by name alone, but if they provide
initial state again it must match the stored value exactly.

Inside subclasses, use the protected getter:

```ts
class Room extends RoomBase<Env> {
  sendMessage(text: string) {
    return {
      room: this.name,
      ownerUserId: this.structuredName.ownerUserId,
      text,
    };
  }
}
```

`this.name`, `this.structuredName`, and `assertInitialized()` throw
`NotInitializedError` synchronously if initialization has not happened. External
callers cannot access the protected getters; their public API is
`initialize({ name })`, `ensureStarted()`, and `assertInitialized()`.

`assertInitialized()` and `this.structuredName` are synchronous reads of already
cached name state. They deliberately do not run startup work. Use
`ensureStarted()` when a public method needs the asynchronous readiness boundary:

```ts
class Room extends RoomBase<Env> {
  async fetch(request: Request) {
    await this.ensureStarted();
    return Response.json({ name: this.name, ownerUserId: this.structuredName.ownerUserId });
  }
}
```

Structured names are persistent identity, not dependency injection. They must be
values that can cross Durable Object RPC and be stored in Durable Object
storage. Do not put API clients, database handles, functions, sockets, or other
runtime objects in a structured name. When the object later starts because of an
alarm or hibernation wake, the runtime gives it only `ctx`, `env`, and local
storage; anything non-serializable would be gone. Store identifiers in the name,
then rebuild clients from `env` inside the object.

`LifecycleStructuredName` is intentionally small: either a string, or a flat
record whose values are `string | number | boolean | null`. Do not nest objects,
arrays, or hashed blobs. If a value is immutable identity for the object, prefer
putting it directly in the structured name; if it is not identity, it belongs in
normal storage/config instead.

`withLifecycleHooks()` intentionally owns two lifecycle moments. Subclasses
should register work for these moments instead of overriding the mixin's public
`initialize()` RPC method:

- `registerOnFirstInitialize(fn)` runs after name state is created for the first
  time. Completion is marked in the Durable Object's own storage. Hooks can
  retry after failure, so external side effects must still be idempotent.
- `registerOnInstanceWake(fn)` runs once for each successful JavaScript
  Durable Object instance wake, after name state exists and after first-initialize
  hooks have completed.

Both hook types are protected so only subclasses and later mixins can register
them. They should be registered in constructors so the full hook list exists
before `initialize()` or `ensureStarted()` starts the lifecycle gate:

```ts
class Room extends RoomBase<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.registerOnFirstInitialize(async (structuredName) => {
      await this.createInitialIndexes(structuredName);
    });

    this.registerOnInstanceWake(() => {
      this.ctx.storage.kv.put("last-woken-room", this.name);
    });
  }
}
```

Hooks are awaited by `initialize()` and `ensureStarted()` by default. That makes
`ensureStarted()` an honest readiness boundary: after it resolves, name state
exists, first-initialize hooks have completed, and instance wake hooks have
completed.
If work is only a best-effort mirror or log, start a separate caught promise and
return quickly:

```ts
this.registerOnInstanceWake((params) => {
  void this.updateExternalIndex(params).catch((error) => {
    console.error("failed to update external index", error);
  });
});
```

Do not use `ctx.waitUntil()` as a lifetime primitive here. Cloudflare documents
that it has no effect in Durable Objects; DOs remain active while there is
ongoing work or pending I/O. The important part is catching the detached promise
so best-effort work cannot become an unhandled rejection.

Instance wake hooks are retryable until the whole startup gate succeeds. If one
instance wake hook writes to an external system and a later instance wake hook
fails, the earlier hook may run again on the next `ensureStarted()` attempt.
Treat instance wake hooks as at-least-once work unless they only mutate local
Durable Object storage inside the same startup gate.

`registerOnFirstInitialize()` is not a distributed exactly-once guarantee. It
marks completion in the Durable Object after the hook succeeds. If the hook
writes to D1 and then crashes before the local completion marker is written, the
hook may run again. That is why first-initialize hooks that touch external
systems must use idempotent writes such as `INSERT ... ON CONFLICT`.

Initialization is idempotent for the same object name and same structured name.
If a Durable Object already has stored lifecycle name state, `initialize()`
returns that existing structured name instead of overwriting it. A different
`name`, a different parsed structured name, or different provided initial state
is treated as a programming error because otherwise callers could silently
disagree about the identity or immutable setup of the same named object.

## D1 Object Catalog

`withLifecycleHooks()` requires an explicit `d1ObjectCatalog` setting. Use
`"none"` for deliberate opt-out, or provide `getDatabase(env)` instead of a
string binding name. That keeps the type story explicit: the call site decides
the minimal `Env` shape that can retrieve D1, and the returned mixin class keeps
that shape as the lower bound for `class Room extends RoomBase<Env>`.

```ts
type NeedsCatalog = {
  DO_CATALOG: D1Database;
};

const RoomBase = withLifecycleHooks<RoomInit, undefined, NeedsCatalog>({
  d1ObjectCatalog: {
    className: "Room",
    getDatabase(env) {
      return env.DO_CATALOG;
    },
    indexes: {
      ownerUserId(params) {
        return params.ownerUserId;
      },
    },
  },
  nameSchema: RoomInit,
})(withDurableObjectCore(DurableObject));
```

The D1 write is best-effort and idempotent. The mixin sends
`CREATE TABLE IF NOT EXISTS` for its object and index tables in the same D1
batch as each upsert, so object construction does not block on catalog-table
setup.

Catalog writes happen from the lifecycle instance wake hook as a detached,
caught promise. The Durable Object's local initialization remains the source of
truth, and D1 is only a discoverability index.
`getD1ObjectCatalogRecord()` therefore returns `null` when the object is
uninitialized, the background D1 write has not completed yet, or the catalog
tables do not exist yet. It never uses
`undefined` as the public "missing row" value because `Response.json(undefined)`
throws in Worker runtimes.

The object row is keyed by `(class, name)`. `created_at` is the first insert
time, while `last_woken_at` is updated whenever the instance wake hook runs. The
D1 mirror stores `structuredName` as JSON text, so only use the flat
JSON-compatible structured-name shape supported by `withLifecycleHooks()`.

Secondary indexes are stored in a separate table:

```sql
PRIMARY KEY (class, index_name, index_value, name)
```

That avoids dynamic D1 columns and migrations for every new lookup dimension.
Index functions should derive stable values from structured names, for example
`ownerUserId`, `projectId`, or a list of member IDs:

```ts
indexes: {
  ownerUserId: (params) => params.ownerUserId,
  projectId: (params) => params.projectId,
  memberUserIds: (params) => params.memberUserIds,
}
```

Use the free helpers when listing from outside a specific Durable Object:

```ts
await getD1ObjectCatalogRecord<RoomInit>(env.DO_CATALOG, {
  className: "Room",
  name: "room-a",
});

await listD1ObjectCatalogRecordsByIndex<RoomInit>(env.DO_CATALOG, {
  className: "Room",
  indexName: "ownerUserId",
  indexValue: "user-a",
});
```

## Debug Inspectors

The inspector mixins are intentionally noisy at the call site:

```ts
const InspectorBase = withKvInspector({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
})(
  withOuterbase({
    unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
  })(withDurableObjectCore(DurableObject)),
);
```

These routes expose storage directly. They are acceptable for local/test
workers and explicitly gated development routes, but they are not safe as a
default production route.

The `unsafe` option is only an acknowledgement at the composition site. It is
not runtime authentication. `/__kv/json` can expose every KV entry in the
object, and `/__outerbase/sql` can execute arbitrary SQL against the object's
SQLite storage. The `/__outerbase` page embeds `https://libsqlstudio.com` and
posts query results/errors to that iframe, so do not mount it where third-party
UI exposure is unacceptable.

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

The deployment script expects these variables from the current environment:
`ALCHEMY_PASSWORD`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID`.
`DURABLE_OBJECT_UTILS_E2E_WORKER_ROUTES` is optional when workers.dev is
available, and required when the account does not return a workers.dev URL. Use
whichever `_shared` Doppler config should own the deployment, for example
`dev_jonas`, `dev`, or `test`.

## Local Rules

- Keep imports pointed at concrete files or package subpaths; do not add barrel files.
- Keep public exports minimal. Every exported type/function is package API.
- Prefer Cloudflare's mixin shape where possible: a named return surface intersected with the base constructor, like `withVoice(Agent)`.
- Link first-party sources in comments when a Cloudflare or Alchemy behavior is non-obvious.
