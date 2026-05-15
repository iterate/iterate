/// <reference types="@cloudflare/workers-types" />

/**
 * Test-only fronting Worker for the Durable Object mixins.
 *
 * The worker-pool unit tests and deployed E2E tests both use this module as the
 * Worker entrypoint. It gives tests normal HTTP routes while still exercising
 * real Durable Object stubs, RPC methods, fetch wrapping, D1 bindings, and
 * SQLite-backed DO storage. Keeping that wiring in one place makes the unit and
 * deployed tests cover the same composition shape.
 */

import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { withAppConfig } from "../mixins/with-app-config.ts";
import { listD1ObjectCatalogRecordsByIndex } from "../mixins/with-lifecycle-hooks.ts";
import { withDurableObjectCore } from "../mixins/with-durable-object-core.ts";
import {
  deriveDurableObjectNameFromStructuredName,
  getInitializedDoStub,
  withLifecycleHooks,
} from "../mixins/with-lifecycle-hooks.ts";
import { withKvInspector } from "../mixins/with-kv-inspector.ts";
import { withMultiplexedAlarms } from "../mixins/with-multiplexed-alarms.ts";
import { withOuterbase } from "../mixins/with-outerbase.ts";
import {
  registerDurableObjectPublicRoute,
  routeDurableObjectRequest,
  withPublicFetchRoute,
} from "../mixins/with-public-fetch-route.ts";
import { withScheduler } from "../mixins/with-scheduler.ts";
import type { SchedulerRecurrence } from "../mixins/with-scheduler.ts";

export type RoomInit = {
  ownerUserId: string;
};

export type RoomInitialState = {
  projectId: string;
  plan: "free" | "pro";
};

const RoomInit = z
  .object({
    ownerUserId: z.string(),
    testName: z.string().optional(),
  })
  .transform(({ ownerUserId }) => ({ ownerUserId }));

const RoomInitialState = z.object({
  projectId: z.string(),
  plan: z.enum(["free", "pro"]),
});

export type SendMessageResult = {
  room: string;
  ownerUserId: string;
  text: string;
};

export type CaughtErrorResult = {
  kind: "error";
  name: string;
  message: string;
};

type Env = {
  ALARM_ROOMS: DurableObjectNamespace<AlarmTestRoom>;
  ALARM_FORWARDING_ROOMS: DurableObjectNamespace<AlarmForwardingTestRoom>;
  SCHEDULE_ROOMS: DurableObjectNamespace<SchedulerTestRoom>;
  ROOMS: DurableObjectNamespace<InitializeTestRoom>;
  INSPECTORS: DurableObjectNamespace<InspectorTestRoom>;
  LISTED_ROOMS: DurableObjectNamespace<ListedRoom>;
  PUBLIC_ROUTE_ROOMS: DurableObjectNamespace<PublicRouteTestRoom>;
  APP_CONFIG_ROOMS: DurableObjectNamespace<AppConfigTestRoom>;
  INITIAL_STATE_ROOMS: DurableObjectNamespace<InitialStateTestRoom>;
  DO_CATALOG: D1Database;
  APP_CONFIG?: string;
  APP_CONFIG_SERVICE_NAME?: string;
  APP_CONFIG_FEATURE__ENABLED?: string;
};

const DurableObjectCore = withDurableObjectCore(DurableObject);

const RoomBase = withLifecycleHooks({
  d1ObjectCatalog: "none",
  nameSchema: RoomInit,
})(DurableObjectCore);
const InitialStateRoomBase = withLifecycleHooks({
  d1ObjectCatalog: "none",
  initialStateSchema: RoomInitialState,
})(DurableObjectCore);

export class InitialStateTestRoom extends InitialStateRoomBase<Env> {
  getInitialStateForTest(): RoomInitialState {
    return this.initialState;
  }

  getNameForTest(): string {
    return this.name;
  }

  async tryInitialize(input: { name: string; initialState?: RoomInitialState }) {
    try {
      return await this.initialize(input);
    } catch (error) {
      return serializeError(error);
    }
  }
}

export class InitializeTestRoom extends RoomBase<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.registerOnFirstInitialize((params) => {
      const runs = this.ctx.storage.kv.get<number>("test.firstInitializeHookRuns") ?? 0;
      this.ctx.storage.kv.put("test.firstInitializeHookRuns", runs + 1);
      this.ctx.storage.kv.put("test.firstInitializeHookOwnerUserId", params.ownerUserId);
    });

    this.registerOnInstanceWake(async () => {
      const runs = this.ctx.storage.kv.get<number>("test.instanceWakeHookRuns") ?? 0;
      this.ctx.storage.kv.put("test.instanceWakeHookRuns", runs + 1);
      this.ctx.storage.kv.put("test.instanceWakeHookStarted", true);

      // Keep this asynchronous so tests prove initialize()/ensureStarted()
      // wait for hook completion rather than fire-and-forget constructor work.
      await Promise.resolve();

      if (this.name.includes("hook-fails-once")) {
        const alreadyFailed =
          this.ctx.storage.kv.get<boolean>("test.instanceWakeHookFailedOnce") ?? false;

        if (!alreadyFailed) {
          this.ctx.storage.kv.put("test.instanceWakeHookFailedOnce", true);
          throw new Error("instance wake hook failed once");
        }
      }

      if (this.name.includes("hook-throws-undefined")) {
        // JavaScript allows throwing any value, including `undefined`.
        // The lifecycle implementation must treat that as a real startup
        // failure rather than confusing it with the "no error captured" state.
        throw undefined;
      }

      this.ctx.storage.kv.put("test.instanceWakeHookFinished", true);
    });
  }

  sendMessage(text: string): SendMessageResult {
    const { ownerUserId } = this.structuredName;

    return {
      room: this.name,
      ownerUserId,
      text,
    };
  }

  getStructuredName(): RoomInit {
    return this.assertInitialized();
  }

  async ensureReady(): Promise<RoomInit> {
    return await this.ensureStarted();
  }

  getLifecycleHookState(): {
    firstInitializeRuns: number;
    firstInitializeOwnerUserId: string | null;
    instanceWakeRuns: number;
    instanceWakeStarted: boolean;
    instanceWakeFinished: boolean;
    instanceWakeFailedOnce: boolean;
  } {
    return {
      firstInitializeRuns: this.ctx.storage.kv.get<number>("test.firstInitializeHookRuns") ?? 0,
      firstInitializeOwnerUserId:
        this.ctx.storage.kv.get<string>("test.firstInitializeHookOwnerUserId") ?? null,
      instanceWakeRuns: this.ctx.storage.kv.get<number>("test.instanceWakeHookRuns") ?? 0,
      instanceWakeStarted:
        this.ctx.storage.kv.get<boolean>("test.instanceWakeHookStarted") ?? false,
      instanceWakeFinished:
        this.ctx.storage.kv.get<boolean>("test.instanceWakeHookFinished") ?? false,
      instanceWakeFailedOnce:
        this.ctx.storage.kv.get<boolean>("test.instanceWakeHookFailedOnce") ?? false,
    };
  }

  async initializeTwiceConcurrently(params: RoomInit): Promise<{
    results: [RoomInit, RoomInit];
    hookRuns: number;
  }> {
    const input = this.getInitializeInput(params);
    const results = (await Promise.all([this.initialize(input), this.initialize(input)])) as [
      RoomInit,
      RoomInit,
    ];

    return {
      results,
      hookRuns: this.getLifecycleHookState().instanceWakeRuns,
    };
  }

  trySendMessage(text: string): SendMessageResult | CaughtErrorResult {
    try {
      return this.sendMessage(text);
    } catch (error) {
      return serializeError(error);
    }
  }

  async tryInitialize(params: RoomInit): Promise<RoomInit | CaughtErrorResult> {
    try {
      return await this.initialize(this.getInitializeInput(params));
    } catch (error) {
      return serializeError(error);
    }
  }

  async tryInitializeName(input: { name: string }): Promise<RoomInit | CaughtErrorResult> {
    try {
      return await this.initialize(input);
    } catch (error) {
      return serializeError(error);
    }
  }

  async tryEnsureReady(): Promise<RoomInit | CaughtErrorResult> {
    try {
      return await this.ensureReady();
    } catch (error) {
      return serializeError(error);
    }
  }

  private getInitializeInput(params: RoomInit): { name: string } {
    const runtimeName = this.getDurableObjectName();
    if (runtimeName !== undefined) {
      return { name: runtimeName };
    }

    return {
      name: deriveDurableObjectNameFromStructuredName({ structuredName: params }),
    };
  }
}

const PublicRouteRoomBase = withPublicFetchRoute({
  namespaceSlug: "public-route-rooms",
  defaultAddressing: "by-structured-name",
})(
  withLifecycleHooks({
    d1ObjectCatalog: "none",
    nameSchema: RoomInit,
  })(DurableObjectCore),
);

export class PublicRouteTestRoom extends PublicRouteRoomBase<Env> {
  async fetch(request: Request): Promise<Response> {
    await this.ensureStarted();
    const init = this.assertInitialized();

    const url = new URL(request.url);
    const bodyText =
      request.method === "GET" || request.method === "HEAD" ? null : await request.text();

    return json({
      durableObjectName: this.name,
      ownerUserId: init.ownerUserId,
      pathname: url.pathname,
      search: url.search,
      method: request.method,
      bodyText,
    });
  }

  getIdStringForTest(): string {
    return this.getDurableObjectId().toString();
  }

  getStructuredNameForTest(): RoomInit {
    return this.assertInitialized();
  }

  getPublicPathsForTest(): {
    defaultPath: string;
    byNamePath: string;
    byIdPath: string;
    byStructuredNamePath: string;
  } {
    return {
      defaultPath: this.getPublicDurableObjectPath(),
      byNamePath: this.getPublicDurableObjectPath({ mode: "by-name" }),
      byIdPath: this.getPublicDurableObjectPath({ mode: "by-id" }),
      byStructuredNamePath: this.getPublicDurableObjectPath({ mode: "by-structured-name" }),
    };
  }
}

const ListedRoomBase = withLifecycleHooks<RoomInit, undefined, Env>({
  d1ObjectCatalog: {
    className: "ListedRoom",
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
})(DurableObjectCore);

export class ListedRoom extends ListedRoomBase<Env> {
  getStructuredName(): RoomInit {
    return this.assertInitialized();
  }
}

const AlarmRoomBase = withMultiplexedAlarms<RoomInit>()(
  withLifecycleHooks({
    d1ObjectCatalog: "none",
    nameSchema: RoomInit,
  })(DurableObjectCore),
);

export class AlarmTestRoom extends AlarmRoomBase<Env> {
  async scheduleRecordAlarm(input: {
    key: string;
    runAt: number;
    payload?: unknown;
  }): Promise<void | CaughtErrorResult> {
    try {
      await this.scheduleMultiplexedAlarm({
        key: input.key,
        runAt: input.runAt,
        method: "recordAlarmPayload",
        payload: input.payload,
      });
    } catch (error) {
      return serializeError(error);
    }
  }

  async scheduleMissingMethodAlarm(input: {
    key: string;
    runAt: number;
  }): Promise<void | CaughtErrorResult> {
    try {
      await this.scheduleMultiplexedAlarm({
        key: input.key,
        runAt: input.runAt,
        method: "missingAlarmMethod",
      });
    } catch (error) {
      return serializeError(error);
    }
  }

  async scheduleSelfReplacingAlarm(input: {
    key: string;
    runAt: number;
  }): Promise<void | CaughtErrorResult> {
    try {
      await this.scheduleMultiplexedAlarm({
        key: input.key,
        runAt: input.runAt,
        method: "replaceAlarmDuringDispatch",
        payload: {
          key: input.key,
        },
      });
    } catch (error) {
      return serializeError(error);
    }
  }

  async scheduleUnserializableAlarm(): Promise<void | CaughtErrorResult> {
    const payload: { self?: unknown } = {};
    payload.self = payload;

    try {
      await this.scheduleMultiplexedAlarm({
        key: "unserializable",
        runAt: Date.now(),
        method: "recordAlarmPayload",
        payload,
      });
    } catch (error) {
      return serializeError(error);
    }
  }

  async cancelRecordAlarm(key: string): Promise<boolean> {
    return await this.cancelMultiplexedAlarm(key);
  }

  async runAlarmNow(): Promise<void | CaughtErrorResult> {
    try {
      const alarm = this.alarm;

      if (alarm === undefined) {
        throw new Error("alarm() is not installed.");
      }

      await alarm.call(this);
    } catch (error) {
      return serializeError(error);
    }
  }

  seedMissingMethodAlarmRow(key: string): void {
    const now = Date.now();

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO mixin_multiplexed_alarms
        (key, method, payload_json, run_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      key,
      "missingAfterDeploy",
      "null",
      now - 1,
      now,
      now,
    );
  }

  async makeMultiplexedAlarmsDueForTest(): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE mixin_multiplexed_alarms SET run_at_ms = ?", Date.now() - 1);
    await this.ctx.storage.deleteAlarm();
  }

  getAlarmExecutionState(): {
    runs: number;
    payload: unknown;
  } {
    return {
      runs: this.ctx.storage.kv.get<number>("test.alarmRuns") ?? 0,
      payload: this.ctx.storage.kv.get<unknown>("test.alarmPayload") ?? null,
    };
  }

  async getPlatformAlarm(): Promise<number | null> {
    return await this.ctx.storage.getAlarm();
  }

  protected recordAlarmPayload(payload: unknown): void {
    const runs = this.ctx.storage.kv.get<number>("test.alarmRuns") ?? 0;

    this.ctx.storage.kv.put("test.alarmRuns", runs + 1);
    this.ctx.storage.kv.put("test.alarmPayload", payload);
  }

  protected async replaceAlarmDuringDispatch(payload: unknown): Promise<void> {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("key" in payload) ||
      typeof payload.key !== "string"
    ) {
      throw new Error("replaceAlarmDuringDispatch payload must include key.");
    }

    await this.scheduleMultiplexedAlarm({
      key: payload.key,
      runAt: Date.now() + 60_000,
      method: "recordAlarmPayload",
      payload: { version: "replacement" },
    });
  }
}

const AlarmForwardingLifecycleBase = withLifecycleHooks({
  d1ObjectCatalog: "none",
  nameSchema: RoomInit,
})(DurableObjectCore);

class AlarmForwardingRoot<FinalEnv> extends AlarmForwardingLifecycleBase<FinalEnv> {
  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    this.ctx.storage.kv.put("test.forwardedAlarmInfo", alarmInfo ?? null);
  }
}

const AlarmForwardingRoomBase = withMultiplexedAlarms<RoomInit>()(AlarmForwardingRoot);

export class AlarmForwardingTestRoom extends AlarmForwardingRoomBase<Env> {
  getForwardedAlarmInfo(): AlarmInvocationInfo | null {
    return this.ctx.storage.kv.get<AlarmInvocationInfo | null>("test.forwardedAlarmInfo") ?? null;
  }

  async runAlarmNow(alarmInfo?: AlarmInvocationInfo): Promise<void | CaughtErrorResult> {
    try {
      const alarm = this.alarm;

      if (alarm === undefined) {
        throw new Error("alarm() is not installed.");
      }

      await alarm.call(this, alarmInfo);
    } catch (error) {
      return serializeError(error);
    }
  }
}

const SchedulerRoomBase = withScheduler<RoomInit>()(
  withMultiplexedAlarms<RoomInit>()(
    withLifecycleHooks({
      d1ObjectCatalog: "none",
      nameSchema: RoomInit,
    })(DurableObjectCore),
  ),
);

export class SchedulerTestRoom extends SchedulerRoomBase<Env> {
  async scheduleTask(input: {
    key: string;
    recurrence: SchedulerRecurrence;
    payload?: unknown;
  }): Promise<unknown> {
    try {
      return await this.schedule({
        key: input.key,
        method: "recordScheduledPayload",
        payload: input.payload,
        recurrence: input.recurrence,
      });
    } catch (error) {
      return serializeError(error);
    }
  }

  async scheduleFailingTask(input: {
    key: string;
    recurrence: SchedulerRecurrence;
  }): Promise<unknown> {
    try {
      return await this.schedule({
        key: input.key,
        method: "failScheduledTask",
        recurrence: input.recurrence,
      });
    } catch (error) {
      return serializeError(error);
    }
  }

  async scheduleSelfReplacingTask(input: {
    key: string;
    recurrence: SchedulerRecurrence;
  }): Promise<unknown> {
    try {
      return await this.schedule({
        key: input.key,
        method: "replaceScheduleDuringRun",
        payload: {
          key: input.key,
        },
        recurrence: input.recurrence,
      });
    } catch (error) {
      return serializeError(error);
    }
  }

  async cancelTask(key: string): Promise<boolean> {
    return await this.cancelSchedule(key);
  }

  async runAlarmNow(): Promise<void | CaughtErrorResult> {
    try {
      const alarm = this.alarm;

      if (alarm === undefined) {
        throw new Error("alarm() is not installed.");
      }

      await alarm.call(this);
    } catch (error) {
      return serializeError(error);
    }
  }

  async makeScheduleDueForTest(key: string): Promise<void> {
    const now = Date.now() - 1;
    const existing = this.ctx.storage.sql
      .exec<{ next_run_at_ms: number }>(
        "SELECT next_run_at_ms FROM mixin_scheduler_schedules WHERE key = ? LIMIT 1",
        key,
      )
      .toArray()[0];

    if (existing !== undefined) {
      await this.cancelMultiplexedAlarm(`scheduler:${key}:${existing.next_run_at_ms}`);
    }

    this.ctx.storage.sql.exec(
      "UPDATE mixin_scheduler_schedules SET next_run_at_ms = ? WHERE key = ?",
      now,
      key,
    );
    await this.scheduleMultiplexedAlarm({
      key: `scheduler:${key}:${now}`,
      runAt: now,
      method: "runScheduledTask",
      payload: {
        key,
        expectedRunAtMs: now,
      },
    });
    await this.ctx.storage.deleteAlarm();
  }

  async simulateRunningScheduleForTest(key: string, startedAtMs: number): Promise<void> {
    await this.makeScheduleDueForTest(key);
    this.ctx.storage.sql.exec(
      `UPDATE mixin_scheduler_schedules
       SET running = 1, execution_started_at_ms = ?
       WHERE key = ?`,
      startedAtMs,
      key,
    );
  }

  seedScheduleRowBeforeStartup(key: string): void {
    const now = Date.now();

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO mixin_scheduler_schedules
        (key, method, payload_json, recurrence_json, next_run_at_ms, running,
         execution_started_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      key,
      "recordScheduledPayload",
      "null",
      JSON.stringify({
        type: "delayed",
        delayMs: 60_000,
      }),
      now + 60_000,
      now,
      now,
    );
  }

  async seedExhaustedFiniteRruleScheduleForTest(key: string): Promise<void> {
    const now = Date.now();
    const onlyOccurrenceMs = now - 60_000;

    // This is the shape a finite RRULE has after its last occurrence becomes
    // due: the scheduler row is due now, but asking the RRULE library for the
    // next occurrence after the callback completes will return null. The
    // production scheduler must treat that as "schedule complete", not as an
    // alarm failure that Cloudflare retries forever.
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO mixin_scheduler_schedules
        (key, method, payload_json, recurrence_json, next_run_at_ms, running,
         execution_started_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      key,
      "recordScheduledPayload",
      JSON.stringify({ final: true }),
      JSON.stringify({
        type: "rrule",
        rrule: "FREQ=DAILY;COUNT=1",
        timezone: null,
        dtstartMs: onlyOccurrenceMs,
      }),
      now,
      now,
      now,
    );

    await this.scheduleMultiplexedAlarm({
      key: `scheduler:${key}:${now}`,
      runAt: now,
      method: "runScheduledTask",
      payload: {
        key,
        expectedRunAtMs: now,
      },
    });
    await this.ctx.storage.deleteAlarm();
  }

  getScheduledExecutionState(): {
    runs: number;
    failures: number;
    payload: unknown;
  } {
    return {
      runs: this.ctx.storage.kv.get<number>("test.scheduleRuns") ?? 0,
      failures: this.ctx.storage.kv.get<number>("test.scheduleFailures") ?? 0,
      payload: this.ctx.storage.kv.get<unknown>("test.schedulePayload") ?? null,
    };
  }

  getScheduleNextRunAtMsForTest(key: string): number | null {
    const schedule = this.getSchedule(key);

    return schedule === null ? null : Date.parse(schedule.nextRunAt);
  }

  protected recordScheduledPayload(payload: unknown): void {
    const runs = this.ctx.storage.kv.get<number>("test.scheduleRuns") ?? 0;

    this.ctx.storage.kv.put("test.scheduleRuns", runs + 1);
    this.ctx.storage.kv.put("test.schedulePayload", payload);
  }

  protected failScheduledTask(): void {
    const failures = this.ctx.storage.kv.get<number>("test.scheduleFailures") ?? 0;

    this.ctx.storage.kv.put("test.scheduleFailures", failures + 1);
    throw new Error("scheduled task failed");
  }

  protected async replaceScheduleDuringRun(payload: unknown): Promise<void> {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("key" in payload) ||
      typeof payload.key !== "string"
    ) {
      throw new Error("replaceScheduleDuringRun payload must include key.");
    }

    await this.schedule({
      key: payload.key,
      method: "recordScheduledPayload",
      payload: { version: "replacement" },
      recurrence: {
        type: "delayed",
        delayMs: 60_000,
      },
    });
  }
}

const InspectorBase = withKvInspector({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
})(
  withOuterbase({
    unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
  })(DurableObjectCore),
);

export class InspectorTestRoom extends InspectorBase<Env> {
  seedKv(key: string, value: unknown) {
    this.ctx.storage.kv.put(key, value);
  }

  seedSql() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, text TEXT)",
    );
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO messages (id, text) VALUES (?, ?)",
      "msg_1",
      "hello",
    );
  }
}

const TestAppConfig = z.object({
  serviceName: z.string().trim().min(1),
  feature: z.object({
    enabled: z.boolean(),
    limit: z.number(),
  }),
  integrations: z.object({
    posthog: z.object({
      projectApiKey: z.string().trim().min(1),
      captureEndpoint: z.url(),
      sampling: z.object({
        enabled: z.boolean(),
        rate: z.number(),
      }),
    }),
  }),
  limits: z.object({
    queue: z.object({
      maxBatchSize: z.number(),
      tags: z.array(z.string()),
    }),
  }),
  optionalText: z.string().default("default-text"),
});

type TestAppConfig = z.output<typeof TestAppConfig>;

const AppConfigRoomBase = withAppConfig(TestAppConfig)(DurableObjectCore);

export class AppConfigTestRoom extends AppConfigRoomBase<Env> {
  getConfigForTest(): TestAppConfig {
    return this.config;
  }

  getConfigReferenceStableForTest(): boolean {
    return this.config === this.config;
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const routedDurableObjectResponse = await routeDurableObjectRequest(request, [
      registerDurableObjectPublicRoute({
        namespace: env.PUBLIC_ROUTE_ROOMS,
        class: PublicRouteTestRoom,
      }),
    ]);
    if (routedDurableObjectResponse !== undefined) {
      return routedDurableObjectResponse;
    }

    const url = new URL(request.url);
    const inspectorMatch = url.pathname.match(/^\/inspectors\/([^/]+)(\/.*)$/);

    if (inspectorMatch !== null) {
      const [, rawName, inspectorPath] = inspectorMatch;
      const stub = env.INSPECTORS.getByName(decodeURIComponent(rawName));

      if (request.method === "POST" && inspectorPath === "/seed-kv") {
        const body = await request.json<{ key?: string; value?: unknown }>();
        await stub.seedKv(requireString(body.key, "key"), body.value);

        return json({ ok: true });
      }

      if (request.method === "POST" && inspectorPath === "/seed-sql") {
        await stub.seedSql();

        return json({ ok: true });
      }

      // The fronting worker keeps the public test URL stable while the DO still
      // exercises the fetch wrapper exactly as it runs in production.
      const proxiedUrl = new URL(inspectorPath, "https://durable-object.local");
      return await stub.fetch(new Request(proxiedUrl, request));
    }

    const listedOwnerIndexMatch = url.pathname.match(/^\/listed-rooms\/by-owner-user-id\/([^/]+)$/);

    if (listedOwnerIndexMatch !== null) {
      const [, rawOwnerUserId] = listedOwnerIndexMatch;

      return json(
        await listD1ObjectCatalogRecordsByIndex<RoomInit>(env.DO_CATALOG, {
          className: "ListedRoom",
          indexName: "ownerUserId",
          indexValue: decodeURIComponent(rawOwnerUserId),
        }),
      );
    }

    const listedMatch = url.pathname.match(/^\/listed-rooms\/([^/]+)\/([^/]+)$/);

    if (listedMatch !== null) {
      const [, rawName, action] = listedMatch;
      const name = decodeURIComponent(rawName);

      if (request.method === "POST" && action === "initialize") {
        const stub = env.LISTED_ROOMS.getByName(name);
        await stub.initialize({ name });

        return json(await stub.getStructuredName());
      }

      if (request.method === "GET" && action === "catalog") {
        const stub = env.LISTED_ROOMS.getByName(name);

        return json(await stub.getD1ObjectCatalogRecord());
      }

      return json({ error: "Not found" }, { status: 404 });
    }

    const alarmMatch = url.pathname.match(/^\/alarm-rooms\/([^/]+)\/([^/]+)$/);

    if (alarmMatch !== null) {
      const [, rawName, action] = alarmMatch;
      const name = decodeURIComponent(rawName);
      const stub = env.ALARM_ROOMS.getByName(name);

      if (request.method === "POST" && action === "initialize") {
        const initialized = await stub.initialize({ name });

        return json(initialized);
      }

      if (request.method === "POST" && action === "schedule") {
        const body = await request.json<{
          key?: string;
          payload?: unknown;
          runAt?: number;
        }>();
        const result = await stub.scheduleRecordAlarm({
          key: requireString(body.key, "key"),
          runAt: body.runAt ?? Date.now() + 60_000,
          payload: body.payload,
        });

        if (isCaughtErrorResult(result)) {
          return json(result, { status: 500 });
        }

        return json({ ok: true });
      }

      if (request.method === "POST" && action === "make-due") {
        await stub.makeMultiplexedAlarmsDueForTest();

        return json({ ok: true });
      }

      if (request.method === "POST" && action === "run-alarm") {
        const result = await stub.runAlarmNow();

        if (isCaughtErrorResult(result)) {
          return json(result, { status: 500 });
        }

        return json({ ok: true });
      }

      if (request.method === "GET" && action === "alarms") {
        return json(await stub.getMultiplexedAlarms());
      }

      if (request.method === "GET" && action === "state") {
        return json(await stub.getAlarmExecutionState());
      }

      return json({ error: "Not found" }, { status: 404 });
    }

    const scheduleMatch = url.pathname.match(/^\/schedule-rooms\/([^/]+)\/([^/]+)$/);

    if (scheduleMatch !== null) {
      const [, rawName, action] = scheduleMatch;
      const name = decodeURIComponent(rawName);
      const stub = env.SCHEDULE_ROOMS.getByName(name);

      if (request.method === "POST" && action === "initialize") {
        const initialized = await stub.initialize({ name });

        return json(initialized);
      }

      if (request.method === "POST" && action === "schedule") {
        const body = await request.json<{
          key?: string;
          payload?: unknown;
          recurrence?: SchedulerRecurrence;
        }>();
        const result = await stub.scheduleTask({
          key: requireString(body.key, "key"),
          recurrence: body.recurrence ?? {
            type: "interval",
            everyMs: 60_000,
          },
          payload: body.payload,
        });

        if (isCaughtErrorResult(result)) {
          return json(result, { status: 500 });
        }

        return json(result);
      }

      if (request.method === "POST" && action === "make-due") {
        const body = await request.json<{ key?: string }>();
        await stub.makeScheduleDueForTest(requireString(body.key, "key"));

        return json({ ok: true });
      }

      if (request.method === "POST" && action === "run-alarm") {
        const result = await stub.runAlarmNow();

        if (isCaughtErrorResult(result)) {
          return json(result, { status: 500 });
        }

        return json({ ok: true });
      }

      if (request.method === "GET" && action === "schedules") {
        return json(await stub.getSchedules());
      }

      if (request.method === "GET" && action === "state") {
        return json(await stub.getScheduledExecutionState());
      }

      return json({ error: "Not found" }, { status: 404 });
    }

    const match = url.pathname.match(/^\/rooms\/([^/]+)\/([^/]+)$/);

    if (match === null) {
      return json({ error: "Not found" }, { status: 404 });
    }

    const [, rawName, action] = match;
    const name = decodeURIComponent(rawName);

    try {
      if (request.method === "POST" && action === "initialize") {
        const body = await request.json<Partial<RoomInit>>();
        const stub = await getInitializedDoStub({
          allowCreate: true,
          namespace: env.ROOMS,
          name: {
            ownerUserId: requireString(body.ownerUserId, "ownerUserId"),
          },
        });

        return json(await stub.getStructuredName());
      }

      if (request.method === "POST" && action === "message") {
        const body = await request.json<{ text?: string }>();
        const stub = env.ROOMS.getByName(name);
        const result = await stub.trySendMessage(requireString(body.text, "text"));

        if (isCaughtErrorResult(result)) {
          return json(
            {
              error: result.name,
              message: result.message,
            },
            { status: 500 },
          );
        }

        return json(result);
      }

      if (request.method === "GET" && action === "init") {
        const stub = env.ROOMS.getByName(name);

        return json(await stub.getStructuredName());
      }

      return json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<Env>;

function requireString(value: string | undefined, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }

  return value;
}

function json(body: unknown, init?: ResponseInit): Response {
  // `Response.json(undefined)` throws because `undefined` is not valid JSON.
  // Normalize it here so future test routes return explicit JSON `null`
  // instead of a Worker exception.
  return Response.json(body ?? null, init);
}

function serializeError(error: unknown): CaughtErrorResult {
  return {
    kind: "error",
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isCaughtErrorResult(value: unknown): value is CaughtErrorResult {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "error";
}
