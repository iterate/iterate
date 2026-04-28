/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";
import type {
  LifecycleHooksMembers,
  LifecycleHooksProtected,
  LifecycleInit,
} from "./with-lifecycle-hooks.ts";
import { stringifyJsonPayload } from "./json-payload.ts";
import type { Constructor, DurableObjectConstructor } from "./mixin-types.ts";

const MULTIPLEXED_ALARMS_TABLE = "mixin_multiplexed_alarms";
const MAX_DUE_ALARMS_PER_TICK = 50;
const MAX_PLATFORM_ALARM_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;

/**
 * Adds a tiny logical-alarm queue on top of Cloudflare's single Durable Object
 * alarm slot.
 *
 * The mixin owns local SQLite table `mixin_multiplexed_alarms`, exposes a
 * public diagnostic read (`getMultiplexedAlarms()`), and gives subclasses or
 * later mixins protected mutation methods. It requires `withLifecycleHooks()`
 * below it so alarms cannot be scheduled or dispatched before the object has
 * durable init params and startup hooks have run.
 */
export type ScheduleMultiplexedAlarmInput = {
  /**
   * Stable logical alarm key.
   *
   * Reusing a key replaces the existing row. This makes mixins safe to call
   * from lifecycle start hooks without creating duplicate work on every
   * Durable Object activation.
   */
  key: string;
  /**
   * Absolute time for the logical alarm. A number is epoch milliseconds,
   * matching Cloudflare's `ctx.storage.setAlarm()` API.
   */
  runAt: Date | number;
  /**
   * Instance method to call when the logical alarm is due.
   *
   * The method can be protected. TypeScript protection is erased at runtime,
   * and the dispatcher calls the method from inside the same class hierarchy.
   */
  method: string;
  /**
   * Payload passed as the method's only argument.
   *
   * Payloads must be JSON-serializable because alarm rows must survive
   * eviction, hibernation, and deploys. We intentionally do not encode JSON
   * serializability in TypeScript because recursive JSON types make call sites
   * noisy while still not proving runtime serializability.
   */
  payload?: unknown;
};

export type MultiplexedAlarmRecord = {
  key: string;
  method: string;
  payload: unknown;
  runAt: string;
  createdAt: string;
  updatedAt: string;
};

export type MultiplexedAlarmsMembers = {
  /**
   * Diagnostic read of persisted logical alarm rows.
   *
   * This deliberately does not require initialization. Seeing alarm rows on an
   * uninitialized object is useful evidence of a broken invariant, and reads do
   * not affect the single platform alarm slot.
   */
  getMultiplexedAlarms(): MultiplexedAlarmRecord[];
};

/**
 * Type-only protected surface for later mixins and subclasses.
 *
 * Interfaces cannot add protected members to a class-expression mixin result,
 * so this abstract class is intersected into the returned constructor type.
 */
export abstract class MultiplexedAlarmsProtected {
  protected scheduleMultiplexedAlarm(_input: ScheduleMultiplexedAlarmInput): Promise<void> {
    throw new Error("MultiplexedAlarmsProtected is type-only and should never run.");
  }

  protected cancelMultiplexedAlarm(_key: string): Promise<boolean> {
    throw new Error("MultiplexedAlarmsProtected is type-only and should never run.");
  }
}

export type WithMultiplexedAlarmsResult<TBase extends DurableObjectConstructor> =
  // Preserve the original class value so `class Room extends Base<Env>` keeps
  // working after this wrapper, matching Cloudflare's `withVoice` style.
  TBase &
    Constructor<MultiplexedAlarmsMembers & MultiplexedAlarmsProtected> &
    // Publish that the wrapped class still has a Durable Object alarm method.
    // Classes above this mixin may override alarm(), but must call
    // `super.alarm?.()` or these logical alarms will not dispatch. The optional
    // call is the TypeScript-friendly shape because Cloudflare's root
    // DurableObject declares alarm as an optional hook.
    (abstract new <Env>(
      ctx: DurableObjectState,
      env: Env,
    ) => DurableObject<Env> & MultiplexedAlarmsMembers);

type MultiplexedAlarmRow = {
  key: string;
  method: string;
  payload_json: string;
  run_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
};

export class MultiplexedAlarmPayloadSerializationError extends Error {
  constructor(cause: unknown) {
    super(
      `Multiplexed alarm payload must be JSON-serializable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "MultiplexedAlarmPayloadSerializationError";
  }
}

export class MissingMultiplexedAlarmMethodError extends Error {
  constructor(key: string, method: string) {
    super(`Multiplexed alarm "${key}" targets missing method "${method}".`);
    this.name = "MissingMultiplexedAlarmMethodError";
  }
}

/**
 * Adds persisted logical alarms behind Cloudflare's single Durable Object alarm slot.
 *
 * Public method: `getMultiplexedAlarms()` for diagnostics.
 * Protected subclass/mixin surface: `scheduleMultiplexedAlarm()` and
 * `cancelMultiplexedAlarm()`. Classes above this mixin may override `alarm()`,
 * but must call `super.alarm?.()` or persisted logical alarms will not dispatch.
 *
 * Cloudflare alarm behavior this mixin is built around:
 * https://developers.cloudflare.com/durable-objects/api/alarms/
 */
export function withMultiplexedAlarms<InitParams extends LifecycleInit>() {
  return function <
    TBase extends DurableObjectConstructor<
      unknown,
      LifecycleHooksMembers<InitParams> & LifecycleHooksProtected<InitParams>
    >,
  >(Base: TBase): WithMultiplexedAlarmsResult<TBase> {
    abstract class MultiplexedAlarmsMixin extends Base implements MultiplexedAlarmsMembers {
      constructor(...args: any[]) {
        super(...args);

        // This is local SQLite-backed Durable Object storage, not D1. These
        // schema calls are synchronous and do not yield the event loop, so the
        // constructor only creates the tiny local table needed to multiplex the
        // single Cloudflare alarm slot.
        this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${MULTIPLEXED_ALARMS_TABLE} (
          key TEXT PRIMARY KEY,
          method TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          run_at_ms INTEGER NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        )`);
        this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS mixin_multiplexed_alarms_run_at
          ON ${MULTIPLEXED_ALARMS_TABLE} (run_at_ms)`);

        this.registerOnStart(() => this.armNextMultiplexedAlarm());
      }

      getMultiplexedAlarms(): MultiplexedAlarmRecord[] {
        return this.ctx.storage.sql
          .exec<MultiplexedAlarmRow>(
            `SELECT key, method, payload_json, run_at_ms, created_at_ms, updated_at_ms
             FROM ${MULTIPLEXED_ALARMS_TABLE}
             ORDER BY run_at_ms ASC, key ASC`,
          )
          .toArray()
          .map(rowToRecord);
      }

      /**
       * Schedule or replace one logical alarm row.
       *
       * The row is durable. The platform alarm is only the wakeup mechanism for
       * the earliest due row because Cloudflare gives each Durable Object one
       * alarm slot.
       */
      protected async scheduleMultiplexedAlarm(
        input: ScheduleMultiplexedAlarmInput,
      ): Promise<void> {
        await this.ensureStarted();

        const runAtMs = normalizeRunAtMs(input.runAt);
        const payloadJson = stringifyPayload(input.payload);
        const nowMs = Date.now();

        this.getMultiplexedAlarmMethod(input.key, input.method);

        this.ctx.storage.sql.exec(
          `INSERT INTO ${MULTIPLEXED_ALARMS_TABLE}
            (key, method, payload_json, run_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             method = excluded.method,
             payload_json = excluded.payload_json,
             run_at_ms = excluded.run_at_ms,
             updated_at_ms = excluded.updated_at_ms`,
          input.key,
          input.method,
          payloadJson,
          runAtMs,
          nowMs,
          nowMs,
        );

        await this.armNextMultiplexedAlarm();
      }

      protected async cancelMultiplexedAlarm(key: string): Promise<boolean> {
        await this.ensureStarted();

        const existing = this.ctx.storage.sql
          .exec<{ key: string }>(
            `SELECT key FROM ${MULTIPLEXED_ALARMS_TABLE} WHERE key = ? LIMIT 1`,
            key,
          )
          .toArray()[0];

        if (existing === undefined) {
          return false;
        }

        this.ctx.storage.sql.exec(`DELETE FROM ${MULTIPLEXED_ALARMS_TABLE} WHERE key = ?`, key);
        await this.armNextMultiplexedAlarm();

        return true;
      }

      /**
       * Owns Cloudflare's single Durable Object alarm for this mixin stack.
       *
       * Classes above this mixin may override alarm(), but must call
       * `super.alarm()` or persisted multiplexed alarms will never dispatch.
       */
      async alarm(): Promise<void> {
        const baseAlarm = Reflect.get(
          Object.getPrototypeOf(MultiplexedAlarmsMixin.prototype),
          "alarm",
          this,
        );

        if (typeof baseAlarm === "function") {
          await (baseAlarm as () => void | Promise<void>).call(this);
        }

        await this.ensureStarted();
        await this.runDueMultiplexedAlarms();
        await this.armNextMultiplexedAlarm();
      }

      private async runDueMultiplexedAlarms(): Promise<void> {
        const nowMs = Date.now();
        const rows = this.ctx.storage.sql
          .exec<MultiplexedAlarmRow>(
            `SELECT key, method, payload_json, run_at_ms, created_at_ms, updated_at_ms
             FROM ${MULTIPLEXED_ALARMS_TABLE}
             WHERE run_at_ms <= ?
             ORDER BY run_at_ms ASC, key ASC
             LIMIT ?`,
            nowMs,
            MAX_DUE_ALARMS_PER_TICK,
          )
          .toArray();

        for (const row of rows) {
          const method = this.getMultiplexedAlarmMethod(row.key, row.method);
          const payload = JSON.parse(row.payload_json) as unknown;

          await method.call(this, payload);

          // The callback can await. While it is awaiting, another RPC or the
          // callback itself can reuse the same logical key to schedule fresh work.
          //
          // Deleting by key alone would silently discard that replacement after
          // the old callback returns. Match the full persisted snapshot we
          // dispatched instead. If the row changed, zero rows are deleted and the
          // replacement remains the owner of this key.
          this.ctx.storage.sql.exec(
            `DELETE FROM ${MULTIPLEXED_ALARMS_TABLE}
             WHERE key = ?
               AND method = ?
               AND payload_json = ?
               AND run_at_ms = ?
               AND updated_at_ms = ?`,
            row.key,
            row.method,
            row.payload_json,
            row.run_at_ms,
            row.updated_at_ms,
          );
        }
      }

      private getMultiplexedAlarmMethod(
        key: string,
        method: string,
      ): (payload: unknown) => void | Promise<void> {
        const target = Reflect.get(this, method);

        if (typeof target !== "function") {
          console.error("[withMultiplexedAlarms] missing alarm method", { key, method });
          throw new MissingMultiplexedAlarmMethodError(key, method);
        }

        return target as (payload: unknown) => void | Promise<void>;
      }

      private async armNextMultiplexedAlarm(): Promise<void> {
        const next = this.ctx.storage.sql
          .exec<{ run_at_ms: number }>(
            `SELECT run_at_ms FROM ${MULTIPLEXED_ALARMS_TABLE}
             ORDER BY run_at_ms ASC, key ASC
             LIMIT 1`,
          )
          .toArray()[0];

        if (next === undefined) {
          await this.ctx.storage.deleteAlarm();
          return;
        }

        const nowMs = Date.now();
        // Keep the logical row at its true due time, but arm Cloudflare's
        // platform alarm at a near-term checkpoint.
        //
        // This prevents two bad production states:
        // 1. long-future logical schedules relying on platform alarm timestamps
        //    beyond the supported/SDK-tested horizon;
        // 2. expired checkpoint alarms deleting the logical row too early.
        //
        // On each checkpoint wake, runDueMultiplexedAlarms() finds no due row and
        // this method re-arms another checkpoint until the real due time arrives.
        // Cloudflare Agents documents the same 30-day ceiling for schedules.
        // https://developers.cloudflare.com/agents/api-reference/schedule-tasks/
        await this.ctx.storage.setAlarm(
          Math.min(Math.max(next.run_at_ms, nowMs), nowMs + MAX_PLATFORM_ALARM_DELAY_MS),
        );
      }
    }

    // TypeScript cannot infer that a class-expression mixin preserves Base's
    // static/generic side while adding a protected scheduling surface. The
    // implementation above provides those runtime methods; this cast publishes
    // the composed class shape used by `class Room extends Base<Env> {}`.
    return MultiplexedAlarmsMixin as unknown as WithMultiplexedAlarmsResult<TBase>;
  };
}

function normalizeRunAtMs(runAt: Date | number): number {
  const timeMs = runAt instanceof Date ? runAt.getTime() : runAt;

  if (!Number.isFinite(timeMs)) {
    throw new Error("runAt must be a finite epoch-millisecond timestamp.");
  }

  return timeMs;
}

function stringifyPayload(payload: unknown): string {
  return stringifyJsonPayload(payload, MultiplexedAlarmPayloadSerializationError);
}

function rowToRecord(row: MultiplexedAlarmRow): MultiplexedAlarmRecord {
  return {
    key: row.key,
    method: row.method,
    payload: JSON.parse(row.payload_json) as unknown,
    runAt: new Date(row.run_at_ms).toISOString(),
    createdAt: new Date(row.created_at_ms).toISOString(),
    updatedAt: new Date(row.updated_at_ms).toISOString(),
  };
}
