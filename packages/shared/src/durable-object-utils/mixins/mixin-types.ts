/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

/**
 * Plain constructor used when a mixin adds instance members.
 *
 * Example:
 *
 *   Constructor<LifecycleHooksMembers<RoomInit>>
 *
 * means "instances constructed by this class have initialize/assertInitialized".
 * Mixin result types intersect this with the wrapped base class so callers keep
 * the base statics and Cloudflare's normal `Base<Env>` extension style.
 */
export type Constructor<T = object> = abstract new (...args: any[]) => T;

/**
 * Generic Durable Object class value used by mixins that must preserve this
 * Cloudflare call-site shape:
 *
 *   const Base = withSomeMixin(...)(DurableObject);
 *   class Room extends Base<Env> {}
 *
 * `ReqEnv` is the minimum Env required by mixins applied so far. `Members` is
 * the instance surface accumulated so far. Keeping both in one constructor type
 * lets later mixins add behavior while retaining earlier env requirements and
 * methods.
 */
export type DurableObjectClass<ReqEnv = unknown, Members = object> = abstract new <
  Env extends ReqEnv,
>(
  ctx: DurableObjectState,
  env: Env,
) => DurableObject<Env> & Members;

export type ReqEnvOf<C> =
  C extends DurableObjectClass<infer ReqEnv, infer _Members> ? ReqEnv : unknown;

export type MembersOf<C> =
  C extends DurableObjectClass<infer _ReqEnv, infer Members> ? Members : object;

/**
 * Copy static properties without copying the original constructor signature.
 *
 * Intersecting two constructor signatures can make TypeScript require both
 * constructors to return the exact same instance type, which breaks composed
 * mixins. StaticSide<TBase> keeps useful statics while the mixin result supplies
 * one generic Durable Object constructor.
 */
export type StaticSide<T> = {
  [K in keyof T]: T[K];
};

/**
 * Runtime constructor used inside mixin implementations.
 *
 * Cloudflare exposes `ctx` and `env` as protected members on `DurableObject`.
 * TypeScript cannot express "this arbitrary base has Cloudflare's protected
 * ctx" structurally, because protected members are nominal. Implementation
 * classes cast their generic mixin base to this constructor before extending
 * it; that is what lets code inside the class use the real Cloudflare APIs:
 *
 *   this.ctx.storage.sql
 *   this.ctx.storage.kv
 *   this.ctx.acceptWebSocket(...)
 *
 * Public result types should usually use `DurableObjectClass` so `Base<Env>`
 * survives composition. Implementation classes sometimes need this non-generic
 * constructor because TypeScript cannot extend arbitrary generic constructor
 * intersections directly.
 */
export type RuntimeDurableObjectConstructor = abstract new (
  ctx: DurableObjectState,
  env: unknown,
) => DurableObject;
