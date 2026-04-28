/// <reference types="@cloudflare/workers-types" />

import type {
  Constructor,
  DurableObjectClass,
  MembersOf,
  ReqEnvOf,
  RuntimeDurableObjectConstructor,
  StaticSide,
} from "./mixin-types.ts";

/**
 * Type-only protected surface for raw Durable Object runtime capabilities.
 *
 * This is intentionally protected, not public. Public Durable Object methods are
 * remotely callable over RPC, and these helpers expose low-level storage/alarm
 * controls that should only be available to subclasses and later mixins.
 *
 * The real implementations are installed by `withDurableObjectCore()` below.
 */
export abstract class DurableObjectCoreProtected {
  protected getDurableObjectSql(): SqlStorage {
    throw new Error("DurableObjectCoreProtected is type-only and should never run.");
  }

  protected getDurableObjectKv(): SyncKvStorage {
    throw new Error("DurableObjectCoreProtected is type-only and should never run.");
  }

  protected transactionSync<T>(_closure: () => T): T {
    throw new Error("DurableObjectCoreProtected is type-only and should never run.");
  }

  protected getDurableObjectId(): DurableObjectId {
    throw new Error("DurableObjectCoreProtected is type-only and should never run.");
  }

  protected getDurableObjectName(): string | undefined {
    throw new Error("DurableObjectCoreProtected is type-only and should never run.");
  }

  protected getDurableObjectAlarm(): Promise<number | null> {
    throw new Error("DurableObjectCoreProtected is type-only and should never run.");
  }

  protected blockDurableObjectConcurrencyWhile<T>(_callback: () => Promise<T>): Promise<T> {
    throw new Error("DurableObjectCoreProtected is type-only and should never run.");
  }

  protected setDurableObjectAlarm(runAt: Date | number): Promise<void> {
    void runAt;
    throw new Error("DurableObjectCoreProtected is type-only and should never run.");
  }

  protected deleteDurableObjectAlarm(): Promise<void> {
    throw new Error("DurableObjectCoreProtected is type-only and should never run.");
  }
}

type WithDurableObjectCoreResult<TBase extends DurableObjectClass> = StaticSide<TBase> &
  DurableObjectClass<ReqEnvOf<TBase>, MembersOf<TBase> & DurableObjectCoreProtected> &
  Constructor<DurableObjectCoreProtected>;

/**
 * Adapts Cloudflare's protected Durable Object runtime APIs into protected
 * capabilities for our mixin stack.
 *
 * This is the bottom layer for mixins that need local SQLite, synchronous KV,
 * or the single platform alarm slot. It mirrors the Agents SDK pattern: `Agent`
 * wraps `ctx.storage.sql` once as `sql()`, and feature mixins like `withVoice`
 * depend on that capability instead of reaching into `ctx` themselves.
 *
 * Keep this tiny. It is not a storage framework; it is the one place where our
 * reusable mixins are allowed to adapt Cloudflare's protected `ctx` surface.
 *
 * Cloudflare Durable Object storage and alarm APIs:
 * https://developers.cloudflare.com/durable-objects/api/storage-api/
 * https://developers.cloudflare.com/durable-objects/api/alarms/
 */
export function withDurableObjectCore<TBase extends DurableObjectClass>(
  Base: TBase,
): WithDurableObjectCoreResult<TBase> {
  abstract class DurableObjectCoreMixin extends (Base as unknown as RuntimeDurableObjectConstructor) {
    protected getDurableObjectSql(): SqlStorage {
      return this.ctx.storage.sql;
    }

    protected getDurableObjectKv(): SyncKvStorage {
      return this.ctx.storage.kv;
    }

    protected transactionSync<T>(closure: () => T): T {
      return this.ctx.storage.transactionSync(closure);
    }

    protected getDurableObjectId(): DurableObjectId {
      return this.ctx.id;
    }

    protected getDurableObjectName(): string | undefined {
      return this.ctx.id.name;
    }

    protected async getDurableObjectAlarm(): Promise<number | null> {
      return await this.ctx.storage.getAlarm();
    }

    protected async blockDurableObjectConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
      return await this.ctx.blockConcurrencyWhile(callback);
    }

    protected async setDurableObjectAlarm(runAt: Date | number): Promise<void> {
      await this.ctx.storage.setAlarm(runAt);
    }

    protected async deleteDurableObjectAlarm(): Promise<void> {
      await this.ctx.storage.deleteAlarm();
    }
  }

  // TypeScript cannot infer that a class-expression wrapper preserves the
  // generic `Base<Env>` constructor while adding protected members. The result
  // type above publishes that composed shape and keeps these raw capabilities
  // out of the public RPC surface.
  return DurableObjectCoreMixin as unknown as WithDurableObjectCoreResult<TBase>;
}
