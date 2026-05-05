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
import {
  listD1ObjectCatalogRecordsByIndex,
  withD1ObjectCatalog,
} from "../mixins/with-d1-object-catalog.ts";
import { withDurableObjectCore } from "../mixins/with-durable-object-core.ts";
import { withDurableObjectViews } from "../mixins/with-durable-object-views.ts";
import type {
  HibernatingWebSocketConnection,
  HibernatingWebSocketConnectionContext,
  HibernatingWebSocketMessage,
} from "../mixins/with-hibernating-websockets.ts";
import { withHibernatingWebSockets } from "../mixins/with-hibernating-websockets.ts";
import { getOrInitializeDoStub, withLifecycleHooks } from "../mixins/with-lifecycle-hooks.ts";
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
  name: string;
  ownerUserId: string;
};

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
  HIBERNATING_WEBSOCKET_ROOMS: DurableObjectNamespace<HibernatingWebSocketTestRoom>;
  DURABLE_OBJECT_VIEW_ROOMS: DurableObjectNamespace<DurableObjectViewTestRoom>;
  DO_CATALOG: D1Database;
  APP_CONFIG?: string;
  APP_CONFIG_SERVICE_NAME?: string;
  APP_CONFIG_FEATURE__ENABLED?: string;
};

const DurableObjectCore = withDurableObjectCore(DurableObject);

const RoomBase = withLifecycleHooks<RoomInit>()(DurableObjectCore);

export class InitializeTestRoom extends RoomBase<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.registerOnFirstInitialize((params) => {
      const runs = this.ctx.storage.kv.get<number>("test.firstInitializeHookRuns") ?? 0;
      this.ctx.storage.kv.put("test.firstInitializeHookRuns", runs + 1);
      this.ctx.storage.kv.put("test.firstInitializeHookOwnerUserId", params.ownerUserId);
    });

    this.registerOnInstanceWake(async (params) => {
      const runs = this.ctx.storage.kv.get<number>("test.instanceWakeHookRuns") ?? 0;
      this.ctx.storage.kv.put("test.instanceWakeHookRuns", runs + 1);
      this.ctx.storage.kv.put("test.instanceWakeHookStarted", true);

      // Keep this asynchronous so tests prove initialize()/ensureStarted()
      // wait for hook completion rather than fire-and-forget constructor work.
      await Promise.resolve();

      if (params.name.includes("hook-fails-once")) {
        const alreadyFailed =
          this.ctx.storage.kv.get<boolean>("test.instanceWakeHookFailedOnce") ?? false;

        if (!alreadyFailed) {
          this.ctx.storage.kv.put("test.instanceWakeHookFailedOnce", true);
          throw new Error("instance wake hook failed once");
        }
      }

      if (params.name.includes("hook-throws-undefined")) {
        // JavaScript allows throwing any value, including `undefined`.
        // The lifecycle implementation must treat that as a real startup
        // failure rather than confusing it with the "no error captured" state.
        throw undefined;
      }

      this.ctx.storage.kv.put("test.instanceWakeHookFinished", true);
    });
  }

  sendMessage(text: string): SendMessageResult {
    const { name, ownerUserId } = this.initParams;

    return {
      room: name,
      ownerUserId,
      text,
    };
  }

  getInitParams(): RoomInit {
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
    const results = (await Promise.all([this.initialize(params), this.initialize(params)])) as [
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
      return await this.initialize(params);
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
}

const PublicRouteRoomBase = withPublicFetchRoute({
  namespaceSlug: "public-route-rooms",
  defaultAddressing: "by-init-params",
})(withLifecycleHooks<RoomInit>()(DurableObjectCore));

export class PublicRouteTestRoom extends PublicRouteRoomBase<Env> {
  async fetch(request: Request): Promise<Response> {
    await this.ensureStarted();
    const init = this.assertInitialized();

    const url = new URL(request.url);
    const bodyText =
      request.method === "GET" || request.method === "HEAD" ? null : await request.text();

    return json({
      durableObjectName: init.name,
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

  getInitParamsForTest(): RoomInit {
    return this.assertInitialized();
  }

  getPublicPathsForTest(): {
    defaultPath: string;
    byNamePath: string;
    byIdPath: string;
    byInitParamsPath: string;
  } {
    return {
      defaultPath: this.getPublicDurableObjectPath(),
      byNamePath: this.getPublicDurableObjectPath({ mode: "by-name" }),
      byIdPath: this.getPublicDurableObjectPath({ mode: "by-id" }),
      byInitParamsPath: this.getPublicDurableObjectPath({ mode: "by-init-params" }),
    };
  }
}

type HibernatingWebSocketAttachment = {
  label: string;
};

type HibernatingWebSocketHookState = {
  connected: number;
  messages: number;
  closed: number;
  errors: number;
  wakeRuns: number;
  lastConnectionId: string | null;
  lastOriginalUrl: string | null;
  lastAttachment: HibernatingWebSocketAttachment | null;
};

const HibernatingWebSocketRoomBase = withHibernatingWebSockets<RoomInit>()(
  withLifecycleHooks<RoomInit>()(DurableObjectCore),
);

export class HibernatingWebSocketTestRoom extends HibernatingWebSocketRoomBase<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.registerOnInstanceWake(() => {
      this.ctx.storage.kv.put("wakeRuns", (this.ctx.storage.kv.get<number>("wakeRuns") ?? 0) + 1);
    });
  }

  protected getHibernatingWebSocketTags(
    connection: HibernatingWebSocketConnection,
    context: HibernatingWebSocketConnectionContext,
  ): string[] {
    const tags = context.url.searchParams.getAll("tag");
    const role = context.url.searchParams.get("role");
    return role === null ? tags : [...tags, `role:${role}`, `connection:${connection.id}`];
  }

  protected onHibernatingWebSocketConnect(
    connection: HibernatingWebSocketConnection<HibernatingWebSocketAttachment>,
  ): void {
    this.ctx.storage.kv.put("connected", (this.ctx.storage.kv.get<number>("connected") ?? 0) + 1);
    connection.setHibernatingWebSocketAttachment({ label: `attachment:${connection.id}` });
    this.recordConnection(connection);
    connection.send(
      JSON.stringify({
        type: "connected",
        id: connection.id,
        tags: connection.tags,
        originalUrl: connection.originalUrl,
        attachment: connection.getHibernatingWebSocketAttachment(),
      }),
    );
  }

  protected onHibernatingWebSocketMessage(
    connection: HibernatingWebSocketConnection<HibernatingWebSocketAttachment>,
    message: HibernatingWebSocketMessage,
  ): void {
    this.ctx.storage.kv.put("messages", (this.ctx.storage.kv.get<number>("messages") ?? 0) + 1);
    this.recordConnection(connection);

    const text = hibernatingWebSocketMessageToString(message);
    if (text === "attachment") {
      connection.send(
        JSON.stringify({
          type: "attachment",
          attachment: connection.getHibernatingWebSocketAttachment(),
        }),
      );
      return;
    }

    const command = parseCommand(text);
    if (command.type === "broadcast") {
      this.broadcastHibernatingWebSocketMessage(
        JSON.stringify({
          type: "broadcast",
          from: connection.id,
          text: command.text,
        }),
        {
          tag: command.tag,
          except: command.exceptSelf ? connection.id : undefined,
        },
      );
    }
  }

  protected onHibernatingWebSocketClose(
    connection: HibernatingWebSocketConnection<HibernatingWebSocketAttachment>,
  ): void {
    this.ctx.storage.kv.put("closed", (this.ctx.storage.kv.get<number>("closed") ?? 0) + 1);
    this.recordConnection(connection);
  }

  protected onHibernatingWebSocketError(
    connection: HibernatingWebSocketConnection<HibernatingWebSocketAttachment>,
  ): void {
    this.ctx.storage.kv.put("errors", (this.ctx.storage.kv.get<number>("errors") ?? 0) + 1);
    this.recordConnection(connection);
  }

  getHookState(): HibernatingWebSocketHookState {
    return {
      connected: this.ctx.storage.kv.get<number>("connected") ?? 0,
      messages: this.ctx.storage.kv.get<number>("messages") ?? 0,
      closed: this.ctx.storage.kv.get<number>("closed") ?? 0,
      errors: this.ctx.storage.kv.get<number>("errors") ?? 0,
      wakeRuns: this.ctx.storage.kv.get<number>("wakeRuns") ?? 0,
      lastConnectionId: this.ctx.storage.kv.get<string>("lastConnectionId") ?? null,
      lastOriginalUrl: this.ctx.storage.kv.get<string>("lastOriginalUrl") ?? null,
      lastAttachment:
        this.ctx.storage.kv.get<HibernatingWebSocketAttachment>("lastAttachment") ?? null,
    };
  }

  getConnectionIdsForTag(tag: string): string[] {
    return Array.from(this.getHibernatingWebSockets(tag)).map((connection) => connection.id);
  }

  broadcastForTest(args: { text: string; tag?: string; except?: string | string[] }): void {
    this.broadcastHibernatingWebSocketMessage(JSON.stringify({ type: "rpc-broadcast", ...args }), {
      tag: args.tag,
      except: args.except,
    });
  }

  private recordConnection(
    connection: HibernatingWebSocketConnection<HibernatingWebSocketAttachment>,
  ): void {
    this.ctx.storage.kv.put("lastConnectionId", connection.id);
    this.ctx.storage.kv.put("lastOriginalUrl", connection.originalUrl);
    this.ctx.storage.kv.put("lastAttachment", connection.getHibernatingWebSocketAttachment());
  }
}

type DurableObjectViewCounter = {
  count: number;
  ownerUserId: string;
};

type DurableObjectViewHost = {
  getCounterViewForTest(): DurableObjectViewCounter;
};

const DurableObjectViewRoomBase = withPublicFetchRoute({
  namespaceSlug: "durable-object-view-rooms",
  defaultAddressing: "by-name",
})(
  withDurableObjectViews<{ counter: DurableObjectViewCounter }, DurableObjectViewHost>({
    views: {
      counter(room) {
        return room.getCounterViewForTest();
      },
    },
  })(withHibernatingWebSockets<RoomInit>()(withLifecycleHooks<RoomInit>()(DurableObjectCore))),
);

export class DurableObjectViewTestRoom
  extends DurableObjectViewRoomBase<Env>
  implements DurableObjectViewHost
{
  protected onHibernatingWebSocketMessage(
    _connection: HibernatingWebSocketConnection,
    message: HibernatingWebSocketMessage,
  ): Promise<void> | void {
    const text = hibernatingWebSocketMessageToString(message);
    if (text === "increment") {
      this.ctx.storage.kv.put("count", (this.ctx.storage.kv.get<number>("count") ?? 0) + 1);
      return this.broadcastDurableObjectView("counter");
    }
  }

  getCounterViewForTest(): DurableObjectViewCounter {
    return {
      count: this.ctx.storage.kv.get<number>("count") ?? 0,
      ownerUserId: this.initParams.ownerUserId,
    };
  }

  async incrementForTest(): Promise<void> {
    await this.ensureStarted();
    this.ctx.storage.kv.put("count", (this.ctx.storage.kv.get<number>("count") ?? 0) + 1);
    await this.broadcastDurableObjectView("counter");
  }
}

const ListedRoomBase = withD1ObjectCatalog<RoomInit, Env>({
  className: "ListedRoom",
  getDatabase(env) {
    return env.DO_CATALOG;
  },
  indexes: {
    ownerUserId(params) {
      return params.ownerUserId;
    },
  },
})(withLifecycleHooks<RoomInit>()(DurableObjectCore));

export class ListedRoom extends ListedRoomBase<Env> {
  getInitParams(): RoomInit {
    return this.assertInitialized();
  }
}

const AlarmRoomBase = withMultiplexedAlarms<RoomInit>()(
  withLifecycleHooks<RoomInit>()(DurableObjectCore),
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

const AlarmForwardingLifecycleBase = withLifecycleHooks<RoomInit>()(DurableObjectCore);

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
  withMultiplexedAlarms<RoomInit>()(withLifecycleHooks<RoomInit>()(DurableObjectCore)),
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
      registerDurableObjectPublicRoute({
        namespace: env.DURABLE_OBJECT_VIEW_ROOMS,
        class: DurableObjectViewTestRoom,
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

    const hibernatingWebSocketMatch = url.pathname.match(
      /^\/hibernating-websocket-rooms\/([^/]+)(\/.*)$/,
    );

    if (hibernatingWebSocketMatch !== null) {
      const [, rawName, hibernatingWebSocketPath] = hibernatingWebSocketMatch;
      const name = decodeURIComponent(rawName);
      const stub = env.HIBERNATING_WEBSOCKET_ROOMS.getByName(name);

      if (request.method === "POST" && hibernatingWebSocketPath === "/initialize") {
        const body = await request.json<Partial<RoomInit>>();
        return json(
          await stub.initialize({
            name,
            ownerUserId: requireString(body.ownerUserId, "ownerUserId"),
          }),
        );
      }

      if (request.method === "GET" && hibernatingWebSocketPath === "/state") {
        return json(await stub.getHookState());
      }

      if (request.method === "GET" && hibernatingWebSocketPath.startsWith("/connections/")) {
        return json(
          await stub.getConnectionIdsForTag(
            decodeURIComponent(hibernatingWebSocketPath.slice("/connections/".length)),
          ),
        );
      }

      if (request.method === "POST" && hibernatingWebSocketPath === "/broadcast") {
        const body = await request.json<{ text?: string; tag?: string; except?: string[] }>();
        await stub.broadcastForTest({
          text: requireString(body.text, "text"),
          tag: body.tag,
          except: body.except,
        });
        return json({ ok: true });
      }

      const proxiedUrl = new URL(
        `${hibernatingWebSocketPath}${url.search}`,
        "https://durable-object.local",
      );
      return await stub.fetch(new Request(proxiedUrl, request));
    }

    const durableObjectViewMatch = url.pathname.match(
      /^\/durable-object-view-rooms\/([^/]+)\/([^/]+)$/,
    );

    if (durableObjectViewMatch !== null) {
      const [, rawName, action] = durableObjectViewMatch;
      const name = decodeURIComponent(rawName);
      const stub = env.DURABLE_OBJECT_VIEW_ROOMS.getByName(name);

      if (request.method === "POST" && action === "initialize") {
        const body = await request.json<Partial<RoomInit>>();
        return json(
          await stub.initialize({
            name,
            ownerUserId: requireString(body.ownerUserId, "ownerUserId"),
          }),
        );
      }

      if (request.method === "POST" && action === "increment") {
        await stub.incrementForTest();
        return json({ ok: true });
      }

      if (request.method === "GET" && action === "counter") {
        return json(await stub.getCounterViewForTest());
      }

      return json({ error: "Not found" }, { status: 404 });
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
        const body = await request.json<Partial<RoomInit>>();
        const stub = await getOrInitializeDoStub({
          namespace: env.LISTED_ROOMS,
          name,
          initParams: {
            ownerUserId: requireString(body.ownerUserId, "ownerUserId"),
          },
        });

        return json(await stub.getInitParams());
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
        const body = await request.json<Partial<RoomInit>>();
        const initialized = await stub.initialize({
          name,
          ownerUserId: requireString(body.ownerUserId, "ownerUserId"),
        });

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
        const body = await request.json<Partial<RoomInit>>();
        const initialized = await stub.initialize({
          name,
          ownerUserId: requireString(body.ownerUserId, "ownerUserId"),
        });

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
        const stub = await getOrInitializeDoStub({
          namespace: env.ROOMS,
          name,
          initParams: {
            ownerUserId: requireString(body.ownerUserId, "ownerUserId"),
          },
        });

        return json(await stub.getInitParams());
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

        return json(await stub.getInitParams());
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

function hibernatingWebSocketMessageToString(message: HibernatingWebSocketMessage): string {
  return typeof message === "string" ? message : new TextDecoder().decode(message);
}

function parseCommand(
  raw: string,
): { type: "broadcast"; text: string; tag?: string; exceptSelf?: boolean } | { type: "unknown" } {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.type !== "broadcast" || typeof value.text !== "string") {
      return { type: "unknown" };
    }

    return {
      type: "broadcast",
      text: value.text,
      tag: typeof value.tag === "string" ? value.tag : undefined,
      exceptSelf: value.exceptSelf === true,
    };
  } catch {
    return { type: "unknown" };
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
