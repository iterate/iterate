# Durable Object Utils

Utilities here are experimental helpers for composing Cloudflare Durable Object classes from small mixins.

## Current Scope

- `mixins/with-durable-object-core.ts` is the root adapter for mixins that need Cloudflare's protected Durable Object `ctx` APIs. It exposes small protected capabilities for local SQLite, synchronous KV, and the single platform alarm slot.
- `mixins/with-lifecycle-hooks.ts` adds named initialization state and tiny lifecycle hooks for SQLite-backed Durable Objects.
- `mixins/with-d1-object-catalog.ts` best-effort mirrors initialized objects into D1 tables owned by the mixin, with optional secondary indexes derived from init params.
- `mixins/with-multiplexed-alarms.ts` stores many logical one-shot alarms behind Cloudflare's single Durable Object alarm slot.
- `mixins/with-scheduler.ts` adds key-based one-shot, delayed, interval, cron, and RRULE scheduling on top of multiplexed alarms.
- `mixins/with-outerbase.ts` and `mixins/with-kv-inspector.ts` are debug inspector mixins. Do not attach them to production-routed objects without an explicit auth/dev gating decision.
- Avoid adding more mixins or composition helpers without speccing the API shape first.

## Composition Shape

Compose mixins by wrapping the base class, then extend the composed class with
the final worker `Env`:

```ts
type RoomInit = {
  name: string;
  ownerUserId: string;
};

type NeedsCatalog = {
  DO_CATALOG: D1Database;
};

type Env = NeedsCatalog & {
  OTHER_BINDING: Fetcher;
};

const RoomBase = withD1ObjectCatalog<RoomInit, NeedsCatalog>({
  className: "Room",
  getDatabase(env) {
    return env.DO_CATALOG;
  },
  indexes: {
    ownerUserId(params) {
      return params.ownerUserId;
    },
  },
})(withLifecycleHooks<RoomInit>()(withDurableObjectCore(DurableObject)));

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

Simple mixin return types mostly follow this pattern:

```ts
type WithSomeMixinResult<TBase> = TBase & Constructor<MembersAddedByTheMixin>;
```

`TBase` is the important part. If `TBase` is Cloudflare's generic
`DurableObject` class, keeping `TBase` in the return type keeps this valid:

```ts
const Base = withLifecycleHooks<RoomInit>()(withDurableObjectCore(DurableObject));

export class Room extends Base<Env> {}
```

Without `TBase`, TypeScript would know about the new members but forget that
the returned class is still generic in `Env`.

Some mixins also spell out a generic constructor surface explicitly:

```ts
abstract new <FinalEnv extends NeedsCatalog>(
  ctx: DurableObjectState,
  env: FinalEnv,
) => DurableObject<FinalEnv> & D1ObjectCatalogMembers<RoomInit>
```

That is how `withD1ObjectCatalog()` keeps the D1 requirement visible without
forcing the final app env to be exactly the small requirement:

```ts
type NeedsCatalog = {
  DO_CATALOG: D1Database;
};

type Env = NeedsCatalog & {
  OTHER_BINDING: Fetcher;
};

const Base = withD1ObjectCatalog<RoomInit, NeedsCatalog>({
  className: "Room",
  getDatabase(env) {
    return env.DO_CATALOG;
  },
})(withLifecycleHooks<RoomInit>()(withDurableObjectCore(DurableObject)));

class Room extends Base<Env> {} // ok: Env has DO_CATALOG

class Broken extends Base<{ OTHER_BINDING: Fetcher }> {}
// TypeScript error: missing DO_CATALOG
```

The protected `initParams` type uses an abstract class instead of an interface
because TypeScript interfaces cannot add protected members to a class returned
from a mixin:

```ts
abstract class LifecycleHooksProtected<InitParams> {
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
await room.ensureStarted();
room.assertInitialized();
```

## Initialization Shape

Use the free helper as the default way to get a named stub, initializing it if
needed:

```ts
const stub = await getOrInitializeDoStub({
  namespace: env.ROOMS,
  name: "room-a",
  initParams: {
    ownerUserId: "user-a",
  },
});
```

`getOrInitializeDoStub()` always calls `initialize()`, and `initialize()` waits
for `ensureStarted()` before returning. If the init shape is only
`{ name: string }`, `initParams` may be omitted and the helper initializes with
`{ name }`. If the init shape has any other fields, TypeScript requires
`initParams` so the helper cannot return an uninitialized or unstarted stub by
accident.

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
their public API is `initialize(params)`, `ensureStarted()`, and
`assertInitialized()`.

`assertInitialized()` and `this.initParams` are synchronous reads of already
cached init params. They deliberately do not run startup work. Use
`ensureStarted()` when a public method needs the asynchronous readiness
boundary:

```ts
async function handleRequest(this: Room) {
  const init = await this.ensureStarted();
  return init.name;
}
```

Init params are persistent identity/config, not dependency injection. They must
be values that can cross Durable Object RPC and be stored in Durable Object
storage. Do not put API clients, database handles, functions, sockets, or other
runtime objects in init params. When the object later starts because of an alarm
or hibernation wake, the runtime gives it only `ctx`, `env`, and local storage;
anything non-serializable would be gone. Store identifiers and configuration in
init params, then rebuild clients from `env` inside the object.

For the base lifecycle mixin, primitives, arrays, and plain records are safest.
Mixins that mirror data to D1 or alarm/scheduler SQLite rows are stricter: their
init params or payloads must also round-trip through JSON.

`withLifecycleHooks()` intentionally owns two lifecycle moments:

- `registerOnFirstInitialize(fn)` runs after params are created for the first
  time. Completion is marked in the Durable Object's own storage. Hooks can
  retry after failure, so external side effects must still be idempotent.
- `registerOnStart(fn)` runs once per Durable Object activation, after params
  exist and after first-initialize hooks have completed.

Both hook types are protected so only subclasses and later mixins can register
them. They should be registered in constructors so the full hook list exists
before `initialize()` or `ensureStarted()` starts the lifecycle gate:

```ts
class Room extends RoomBase<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.registerOnFirstInitialize(async (params) => {
      await this.createInitialIndexes(params);
    });

    this.registerOnStart((params) => {
      this.ctx.storage.kv.put("last-started-room", params.name);
    });
  }
}
```

Hooks are awaited by `initialize()` and `ensureStarted()` by default. That makes
`ensureStarted()` an honest readiness boundary: after it resolves, params exist,
first-initialize hooks have completed, and start hooks have completed. If work
is only a best-effort mirror or log, start a separate caught promise and return
quickly:

```ts
this.registerOnStart((params) => {
  void this.updateExternalIndex(params).catch((error) => {
    console.error("failed to update external index", error);
  });
});
```

Do not use `ctx.waitUntil()` as a lifetime primitive here. Cloudflare documents
that it has no effect in Durable Objects; DOs remain active while there is
ongoing work or pending I/O. The important part is catching the detached promise
so best-effort work cannot become an unhandled rejection.

Start hooks are retryable until the whole startup gate succeeds. If one start
hook writes to an external system and a later start hook fails, the earlier hook
may run again on the next `ensureStarted()` attempt. Treat start hooks as
at-least-once work unless they only mutate local Durable Object storage inside
the same startup gate.

`registerOnFirstInitialize()` is not a distributed exactly-once guarantee. It
marks completion in the Durable Object after the hook succeeds. If the hook
writes to D1 and then crashes before the local completion marker is written, the
hook may run again. That is why first-initialize hooks that touch external
systems must use idempotent writes such as `INSERT ... ON CONFLICT`.

Initialization is idempotent for the same object name and same parameter shape.
If a Durable Object already has stored init params, `initialize()` returns those
existing params instead of overwriting them. A different `name`, or different
params for the same name, is treated as a programming error because otherwise
different callers could silently disagree about the identity of the same named
object.

## D1 Object Catalog

`withD1ObjectCatalog()` deliberately takes `getDatabase(env)` instead of a
string binding name. That keeps the type story explicit: the call site decides
the minimal `Env` shape that can retrieve D1, and the returned mixin class keeps
that shape as the lower bound for `class Room extends CatalogedRoomBase<Env>`.

```ts
type NeedsCatalog = {
  DO_CATALOG: D1Database;
};

const CatalogedRoomBase = withD1ObjectCatalog<RoomInit, NeedsCatalog>({
  className: "Room",
  getDatabase(env) {
    return env.DO_CATALOG;
  },
  indexes: {
    ownerUserId(params) {
      return params.ownerUserId;
    },
  },
})(withLifecycleHooks<RoomInit>()(withDurableObjectCore(DurableObject)));
```

The D1 write is best-effort and idempotent. The mixin sends
`CREATE TABLE IF NOT EXISTS` for its object and index tables in the same D1
batch as each upsert, so object construction does not block on catalog-table
setup.

Catalog writes happen from the lifecycle start hook as a detached, caught
promise. That is deliberate: this mixin is just a consumer of
`withLifecycleHooks()`, not a separate lifecycle system. The Durable Object's
local initialization remains the source of truth, and D1 is only a
discoverability index.
`getD1ObjectCatalogRecord()` therefore returns `null` when the object is
uninitialized, the background D1 write has not completed yet, or the catalog
tables do not exist yet. It never uses
`undefined` as the public "missing row" value because `Response.json(undefined)`
throws in Worker runtimes.

The object row is keyed by `(class, name)`. `created_at` is the first insert
time, while `last_started_at` is updated whenever the start hook runs. Init
params used with this mixin must be JSON-compatible by convention because the D1
mirror stores them as JSON text. `JSON.stringify()` catches some failures, such
as circular references and `BigInt`, but it can silently drop or coerce nested
functions, `Map`, and class instances. Use plain records/arrays/primitives. This
is stricter than the base lifecycle hooks mixin, which only requires values that
can be persisted in Durable Object storage.

Secondary indexes are stored in a separate table:

```sql
PRIMARY KEY (class, index_name, index_value, name)
```

That avoids dynamic D1 columns and migrations for every new lookup dimension.
Index functions should derive stable values from init params, for example
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
first-initialize hooks, and start hooks have completed. The diagnostic read
`getMultiplexedAlarms()` intentionally does not require initialization because
seeing alarm rows on an uninitialized object is useful debugging evidence.

```ts
type RoomInit = {
  name: string;
  ownerUserId: string;
};

const RoomBase = withMultiplexedAlarms<RoomInit>()(
  withLifecycleHooks<RoomInit>()(withDurableObjectCore(DurableObject)),
);

class Room extends RoomBase<Env> {
  async scheduleSummary() {
    await this.scheduleMultiplexedAlarm({
      key: "daily-summary",
      runAt: Date.now() + 60_000,
      method: "sendDailySummary",
      payload: { room: this.initParams.name },
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
existing row, which makes it safe to call from `registerOnStart()` without
creating duplicates on every Durable Object activation.

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
rebuild dependencies from `env` and use init params only for persisted identity
or configuration.

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
    withLifecycleHooks<RoomInit>()(withDurableObjectCore(DurableObject)),
  ),
);

class Room extends RoomBase<Env> {
  async enableDailySummary() {
    await this.schedule({
      key: "daily-summary",
      method: "sendDailySummary",
      payload: { room: this.initParams.name },
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
schedule, so calls from `registerOnStart()` are idempotent by default:

```ts
this.registerOnStart(() =>
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
    withLifecycleHooks<DiscordInit>()(withDurableObjectCore(DurableObject)),
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
    // current activation a chance to connect now.
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
      console.log("connected Discord gateway for guild", this.initParams.guildId);
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
that a current activation goes idle while the promise is pending, but it cannot
recover the promise, local variables, sockets, or partially completed external
side effects after a restart.

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
