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
 * Standard public result shape for Durable Object mixins.
 *
 * Cloudflare types `ctx.exports` from `Cloudflare.GlobalProps.mainModule` by
 * walking the Worker's top-level exports and checking whether each exported
 * class constructs an instance with Cloudflare's private Durable Object brand.
 * That machinery is documented in the Workers Context API docs:
 *
 * https://developers.cloudflare.com/workers/runtime-apis/context/#exports
 * https://developers.cloudflare.com/workers/runtime-apis/context/#typescript-types-for-ctxexports-and-ctxprops
 *
 * A mixin result must therefore publish exactly one Durable Object constructor
 * shape: `new <Env>(ctx, env) => DurableObject<Env> & accumulatedMembers`.
 * Returning a plain `Constructor<AddedMembers>` as part of the public result can
 * make downstream classes look like "constructs only AddedMembers" to generic
 * mappers such as `Cloudflare.Exports`, which loses both protected `ctx` and
 * Cloudflare's `DurableObjectBranded` instance type.
 *
 * `StaticSide<TBase>` keeps class statics such as public route metadata.
 * `DurableObjectClass<...>` keeps the branded DO instance and the `Base<Env>`
 * subclassing style. Put all protected/public mixin members into
 * `AddedMembers`; do not add a separate member-only constructor to result
 * types.
 */
export type DurableObjectMixinResult<
  TBase extends DurableObjectClass,
  AddedMembers,
  ReqEnv = ReqEnvOf<TBase>,
> = StaticSide<TBase> & DurableObjectClass<ReqEnv, MembersOf<TBase> & AddedMembers>;

/**
 * Runtime constructor used inside mixin implementations.
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

/**
 * Older/simple constructor for a Durable Object class with an optional required
 * Env shape and optional accumulated members.
 *
 * This is deliberately small and shared by mixins so the common "must wrap a
 * DurableObject" constraint has one explanation and one implementation.
 */
export type DurableObjectConstructor<Env = unknown, Members = object> = abstract new (
  ...args: any[]
) => DurableObject<Env> & Members;
