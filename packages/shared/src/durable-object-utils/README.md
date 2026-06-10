# Durable Object Utils

Utilities here are experimental helpers for composing Cloudflare Durable Object classes from small mixins.

## Current Scope

- `mixins/with-durable-object-core.ts` is the root adapter for mixins that need Cloudflare's protected Durable Object `ctx` APIs. It exposes small protected capabilities for local SQLite, synchronous KV, and the single platform alarm slot.
- `mixins/with-app-config.ts` parses typed app runtime config from `APP_CONFIG` / `APP_CONFIG_*` Cloudflare env vars and exposes it as protected `this.config`.
- `mixins/with-lifecycle-hooks.ts` adds reliable named initialization state, tiny lifecycle hooks, and an explicit `d1ObjectCatalog` setting for best-effort D1 catalog projection.
- `mixins/with-multiplexed-alarms.ts` stores many logical one-shot alarms behind Cloudflare's single Durable Object alarm slot.
- `mixins/with-scheduler.ts` adds key-based one-shot, delayed, interval, cron, and RRULE scheduling on top of multiplexed alarms.
- `mixins/with-stream-processor-runner.ts` stores stream processor reduced state/progress per processor slug and exposes protected catch-up / live-event / subscription runner methods. It assumes one stream path per Durable Object instance.
- `mixins/with-public-fetch-route.ts` adds instance helpers for stable public Durable Object paths and a worker-side fetcher that proxies `/durable-objects/:namespaceSlug/:mode/:payload/...` straight to `stub.fetch()`.
- `mixins/with-outerbase.ts` and `mixins/with-kv-inspector.ts` are debug inspector mixins. Do not attach them to production-routed objects without an explicit auth/dev gating decision.
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
method, such as the scheduler or multiplexed alarm dispatcher.

Use `withAppConfig(AppConfig)` when a Durable Object needs the same app runtime
config shape as the worker entrypoint:

```ts
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { BaseAppConfig } from "@iterate-com/shared/config";
import { withAppConfig } from "@iterate-com/shared/durable-object-utils/mixins/with-app-config";

const AppConfig = BaseAppConfig.extend({
  apiBaseUrl: z.string().trim().min(1),
});

type AppConfig = z.output<typeof AppConfig>;

const RoomBase = withAppConfig(AppConfig)(DurableObject);

class Room extends RoomBase<Env> {
  getApiBaseUrl() {
    return this.config.apiBaseUrl;
  }
}
```

`this.config` is protected, not public, because app config can include redacted
secrets or internal URLs. The mixin uses the shared `APP_CONFIG` parser and
caches the parsed object for one Durable Object wake. `APP_CONFIG_FOO__BAR`
overrides `foo.bar`, and unknown override keys fail schema validation instead
of being silently ignored.

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

## Stream Processor Runner

Use `withStreamProcessorRunner(...)` when a Durable Object should persist
reduced state for stream processors and apply the shared processor lifecycle
helpers. The mixin is configured with one processor and scoped stream API, so
the subclass can stay focused on Durable Object entrypoints such as `fetch()` or
`webSocketMessage()`.

For the current one-stream-per-runner model, put the stream path in the
lifecycle structured name. That makes the Durable Object instance itself the
stream-bound processor runner; pushed/subscribed event methods then receive
events, not another loose `streamPath` argument:

```ts
type AgentProcessorStructuredName = {
  streamPath: string;
};

function createProcessor(args: { ctx: DurableObjectState; env: Env }) {
  return createAgentProcessor({
    ai: args.env.AI,
    waitUntil: (promise) => args.ctx.waitUntil(promise),
  });
}

const AgentProcessorBase = withStreamProcessorRunner<
  AgentProcessorStructuredName,
  Env,
  typeof AgentProcessorContract
>({
  processor: createProcessor,
  streamApi(args) {
    return args.ctx.exports.StreamApi({
      props: { streamPath: args.structuredName.streamPath },
    }) as ProcessorStreamApi<typeof AgentProcessorContract>;
  },
})(
  withLifecycleHooks({ d1ObjectCatalog: "none", nameSchema: AgentProcessorStructuredName })(
    withDurableObjectCore(DurableObject),
  ),
);

class AgentProcessorDO extends AgentProcessorBase<Env> {
  async catchUp() {
    return await this.catchUpStreamProcessor();
  }

  async consumeEvent(args: { event: StreamEvent }) {
    return await this.consumeStreamProcessorEvent(args);
  }
}
```

Callers should initialize the object once with the immutable stream binding:

```ts
const runner = await getInitializedDoStub({
  allowCreate: true,
  namespace: env.AGENT_PROCESSORS,
  name: { streamPath },
});

await runner.consumeEvent({ event });
```

The mixin stores its processor state at
`stream-processor:<processor-slug>:stored-state`. That is deliberately simple:
it is for the current "one processor instance is bound to one stream path"
model. If you need Agent + Codemode in one Durable Object, compose them into one
processor first and pass that composed processor to the mixin.

The configured `processor(...)` callback runs once per Durable Object wake and
the result is cached. That is deliberate: processor implementations may keep
runtime-only closure state such as timers, abort controllers, HTTP connections,
or request sequence counters. Reduced state is still stored through the mixin;
the cached processor object only preserves warm-instance state.

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

## Public Fetch Routing

Use `withPublicFetchRoute()` when a Durable Object should advertise a stable
public Worker route while still owning its own internal `fetch()` paths:

```ts
const ProjectBase = withPublicFetchRoute({
  namespaceSlug: "projects",
  defaultAddressing: "by-name",
})(
  withLifecycleHooks({ d1ObjectCatalog: "none", nameSchema: ProjectInit })(
    withDurableObjectCore(DurableObject),
  ),
);

export class Project extends ProjectBase<Env> {
  async fetch(request: Request) {
    await this.ensureStarted();
    return new Response(new URL(request.url).pathname);
  }
}
```

Instances can generate their own public path:

```ts
project.getPublicDurableObjectPath();
project.getPublicDurableObjectPath({ mode: "by-id" });
project.getPublicDurableObjectPath({ mode: "by-structured-name" });
```

The worker entrypoint mounts the proxy once near the top of `fetch()`, similar
to Cloudflare Agents' `routeAgentRequest()` pattern:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const durableObjectResponse = await routeDurableObjectRequest(request, [
      registerDurableObjectPublicRoute({
        namespace: env.PROJECTS,
        class: Project,
      }),
    ]);
    if (durableObjectResponse) {
      return durableObjectResponse;
    }

    return new Response("not a durable object route", { status: 404 });
  },
};
```

Public URLs always use one of these explicit address forms:

- `/durable-objects/:namespaceSlug/by-name/:name/...`
- `/durable-objects/:namespaceSlug/by-id/:durableObjectId/...`
- `/durable-objects/:namespaceSlug/by-structured-name/:encodedCanonicalJson/...`

The fetcher returns `undefined` when the request is outside the
`/durable-objects` prefix, so the worker can continue with its normal routing.
When it does match, the fetcher strips the public prefix, preserves the
remaining path/query/method/headers/body, and forwards the rewritten request to
`stub.fetch()`.

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

## Multiplexed Alarms

Cloudflare gives each Durable Object one platform alarm slot. That is enough
to wake the object, but not enough for multiple mixins to each own their own
timer. `withMultiplexedAlarms()` makes that single slot an implementation
detail: logical alarm rows live in the object's local SQLite storage, and the
platform alarm is always armed for the earliest row.

This mixin requires `withLifecycleHooks()` below it. Scheduling and dispatch
call `ensureStarted()`, so logical alarms only run after initialization,
first-initialize hooks, and instance wake hooks have completed. The diagnostic read
`getMultiplexedAlarms()` intentionally does not require initialization because
seeing alarm rows on an uninitialized object is useful debugging evidence.

```ts
type RoomInit = {
  name: string;
  ownerUserId: string;
};

const RoomBase = withMultiplexedAlarms<RoomInit>()(
  withLifecycleHooks({ d1ObjectCatalog: "none", nameSchema: RoomInit })(
    withDurableObjectCore(DurableObject),
  ),
);

class Room extends RoomBase<Env> {
  async scheduleSummary() {
    await this.scheduleMultiplexedAlarm({
      key: "daily-summary",
      runAt: Date.now() + 60_000,
      method: "sendDailySummary",
      payload: { room: this.name },
    });
  }

  protected async sendDailySummary(payload: unknown) {
    console.log("running daily summary", payload);
  }
}
```

The scheduling APIs are protected because arbitrary callers should not mutate
the object's alarm queue directly. Subclasses and later mixins can schedule or
cancel rows; external callers can only inspect rows through
`getMultiplexedAlarms()` unless the object exposes its own public method.

`key` is a stable idempotency key. Scheduling the same key again replaces the
existing row, which makes it safe to call from `registerOnInstanceWake()` without
creating duplicates on every JavaScript Durable Object instance wake.

`method` is a string on purpose. TypeScript cannot reflect protected instance
methods into a clean payload-safe scheduler API without making the mixin much
harder to explain. The mixin checks at schedule time that the method exists on
the current class, and checks again at dispatch time in case a deploy removed
or renamed the method while a persisted row still exists. Missing methods are
logged and throw `MissingMultiplexedAlarmMethodError`.

Payloads are `unknown` and persisted through JSON text at schedule time.
`JSON.stringify()` catches some failures, such as circular references and
`BigInt`, but it can silently drop or coerce nested functions, `Map`, and class
instances. Do not pass clients, handles, functions, sockets, or class instances.
Alarm rows must survive eviction, hibernation, and deploys, so the method should
rebuild dependencies from `env` and use structured names only for persisted
identity.

Logical alarm rows are one-shot in this first version. Rows are deleted only
after the target method succeeds. If a target method throws, the row remains
and `alarm()` throws, so Cloudflare's normal Durable Object alarm retry
semantics can retry the work. Each alarm tick processes at most 50 due rows and
then re-arms the platform alarm for whatever remains.

If another mixin or subclass above `withMultiplexedAlarms()` overrides
`alarm(alarmInfo)`, it must call `super.alarm?.(alarmInfo)`. Otherwise the
platform alarm will wake the object but the persisted logical rows owned by this
mixin will not dispatch, and lower alarm implementations will lose Cloudflare's
retry metadata.

## Scheduler

`withScheduler()` is the higher-level API for application schedules. It requires
`withMultiplexedAlarms()` below it:

```ts
const RoomBase = withScheduler<RoomInit>()(
  withMultiplexedAlarms<RoomInit>()(
    withLifecycleHooks({ d1ObjectCatalog: "none", nameSchema: RoomInit })(
      withDurableObjectCore(DurableObject),
    ),
  ),
);

class Room extends RoomBase<Env> {
  async enableDailySummary() {
    await this.schedule({
      key: "daily-summary",
      method: "sendDailySummary",
      payload: { room: this.name },
      recurrence: {
        type: "cron",
        expression: "0 9 * * *",
      },
    });
  }

  protected async sendDailySummary(payload: unknown) {
    console.log("daily summary", payload);
  }
}
```

The scheduler deliberately uses an object-bag API instead of Cloudflare Agents'
`schedule(number | Date | string, method, payload)` overload. It is a bit more
verbose, but it keeps the recurrence semantics explicit and follows this repo's
rule to prefer options bags when positional parameters are easy to confuse.

Every schedule has a required `key`. Reusing the same key replaces the existing
schedule, so calls from `registerOnInstanceWake()` are idempotent by default:

```ts
this.registerOnInstanceWake(() =>
  this.schedule({
    key: "poll-api",
    method: "pollAPI",
    recurrence: {
      type: "interval",
      everyMs: 30_000,
    },
  }),
);
```

The supported recurrence tags are:

```ts
type SchedulerRecurrence =
  | { type: "once"; runAt: Date | number }
  | { type: "delayed"; delayMs: number }
  | { type: "interval"; everyMs: number }
  | { type: "cron"; expression: string; timezone?: string }
  | { type: "rrule"; rrule: string; timezone?: string; dtstart?: Date | number };
```

Numbers are epoch milliseconds for `once`, and milliseconds for `delayed` and
`interval`. This differs from Cloudflare Agents, where numeric delays are
seconds; the explicit field names are intended to avoid unit guessing.

Cron uses `croner`, a zero-dependency Worker-safe parser with direct IANA
timezone support. RRULE uses `rrule`, the standard JS RFC 5545 recurrence
library. Both are kept behind the tagged recurrence shape; stored rows keep the
original tag instead of compiling everything into one lossy format. That makes
future bugfixes and migrations much easier to reason about.

If `timezone` is omitted, cron and RRULE schedules are evaluated in UTC. Provide
an IANA timezone only when you want civil-time behavior such as "9am in
Europe/London", including daylight-saving transitions.

Scheduler payloads follow the same JSON-text rule as multiplexed alarms: use
plain records/arrays/primitives, not clients, handles, functions, sockets,
`Map`, or class instances. The runtime catches some stringify failures, but it
does not prove semantic round-tripping for every JavaScript value.

RRULE input is deliberately narrow: pass a bare rule body such as
`FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1`. Use the explicit `dtstart` and `timezone`
fields for start/timezone configuration. Full iCalendar snippets with embedded
`DTSTART`, `RDATE`, `EXDATE`, or `RRULE:` prefixes are rejected so there is only
one source of truth for start and timezone semantics.

`schedule()` and `cancelSchedule()` are protected. That is intentional: public
Durable Object methods are RPC methods, and direct schedule mutation is usually
too broad for external callers. Expose domain-specific public methods such as
`enableDailySummary()` or `disableDailySummary()` from the concrete object.

Failure policy is split by schedule type:

- One-shot and delayed schedules keep their row due when the callback throws.
  The underlying multiplexed alarm also throws, so Cloudflare's normal Durable
  Object alarm retry semantics can retry the work.
- Recurring schedules log the failure and advance to the next occurrence. A
  broken daily cleanup should not wedge the object forever on yesterday's run.
- Interval schedules store `running` and `execution_started_at_ms`. If a due
  interval is still marked running, the scheduler skips overlap and logs. If it
  stays running beyond the hung timeout, the scheduler logs and retries the
  interval, mirroring the important part of Cloudflare Agents' overlap tests.

The scheduled target method receives `(payload, schedule)`. The second argument
is useful for logging or for a callback that handles multiple schedule keys:

```ts
protected async pollAPI(payload: unknown, schedule: SchedulerRecord) {
  console.log("running schedule", schedule.key, payload);
}
```

### Runtime maintenance loops

The scheduler is also the right primitive for periodic runtime maintenance. A
good example is a Durable Object that owns an outbound Discord connection.

The scheduler does **not** make the WebSocket durable. The socket is ordinary
in-memory runtime state and is lost on eviction, deploys, runtime restarts, or
remote close. The durable part is the app-owned desired state plus the schedule
row that periodically calls an idempotent method to make runtime state match
that desired state.

That distinction is important enough to keep out of a separate
`enableKeepAlive()` API. A method that persists `{ key, method, everyMs }` and
calls a method repeatedly is just scheduling. Use `withScheduler()` for that,
and let the concrete object decide that the scheduled method means "ensure this
connection exists".

```ts
type DiscordInit = {
  name: string;
  guildId: string;
};

type Env = {
  DISCORD_GATEWAY_URL: string;
  DISCORD_TOKEN: string;
};

const DiscordBase = withScheduler<DiscordInit>()(
  withMultiplexedAlarms<DiscordInit>()(
    withLifecycleHooks({ d1ObjectCatalog: "none", nameSchema: DiscordInit })(
      withDurableObjectCore(DurableObject),
    ),
  ),
);

export class DiscordConnection extends DiscordBase<Env> {
  #socket: WebSocket | undefined;

  async connect() {
    this.ctx.storage.kv.put("discord.desired", true);

    await this.schedule({
      key: "discord-connection",
      method: "ensureDiscordConnected",
      recurrence: {
        type: "interval",
        everyMs: 30_000,
      },
    });

    // Do not wait for the first interval tick. The scheduled row is what
    // brings the object back after restart; this immediate call gives the
    // current JavaScript instance a chance to connect now.
    await this.ensureDiscordConnected();
  }

  async disconnect() {
    this.ctx.storage.kv.put("discord.desired", false);
    await this.cancelSchedule("discord-connection");

    this.#socket?.close();
    this.#socket = undefined;
  }

  getStatus() {
    return {
      desired: this.ctx.storage.kv.get<boolean>("discord.desired") ?? false,
      connected: this.#socket?.readyState === WebSocket.OPEN,
      schedules: this.getSchedules(),
    };
  }

  protected async ensureDiscordConnected() {
    const desired = this.ctx.storage.kv.get<boolean>("discord.desired") ?? false;

    if (!desired) {
      await this.cancelSchedule("discord-connection");
      this.#socket?.close();
      this.#socket = undefined;
      return;
    }

    if (this.#socket?.readyState === WebSocket.OPEN) {
      return;
    }

    const socket = new WebSocket(this.env.DISCORD_GATEWAY_URL);
    this.#socket = socket;

    socket.addEventListener("open", () => {
      // This is deliberately not a complete Discord gateway implementation.
      // Real code should send a valid Identify or Resume payload and persist
      // enough sequence/session state in DO storage to resume after restart.
      console.log("connected Discord gateway for guild", this.structuredName.guildId);
      socket.send(
        JSON.stringify({
          token: this.env.DISCORD_TOKEN,
        }),
      );
    });

    socket.addEventListener("message", (event) => {
      void this.handleDiscordMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (this.#socket === socket) {
        this.#socket = undefined;
      }
      // The interval schedule will reconnect on the next tick as long as
      // discord.desired is still true.
    });

    socket.addEventListener("error", () => {
      if (this.#socket === socket) {
        this.#socket = undefined;
      }
      socket.close();
      // The interval schedule will reconnect on the next tick.
    });
  }

  private async handleDiscordMessage(data: string | ArrayBuffer) {
    // Discord-specific event handling. Protocol resume state belongs in DO
    // storage, not in #socket or another in-memory field, because the scheduled
    // reconciling method must be able to rebuild from storage after eviction.
    void data;
  }
}
```

The same shape works for event-sourced AI agent loops. Derive "should be
working" from the append-only event log, then schedule an idempotent method that
replays the projection and starts work only if the projection says work is
still needed. Progress belongs in domain events, not in scheduler or keepalive
metadata.

For an opaque long-running promise, use a future `keepAliveWhile({ promise })`
style helper only as best-effort in-memory liveness. It can reduce the chance
that a current JavaScript instance goes idle while the promise is pending, but it
cannot recover the promise, local variables, sockets, or partially completed
external side effects after a restart.

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
