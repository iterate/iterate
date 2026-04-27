/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

type DurableObjectConstructor = abstract new (...args: any[]) => DurableObject;

// A plain constructor type for "this mixin adds these instance members".
//
// Example:
//
//   Constructor<InitializeMembers<RoomInit>>
//
// means "instances constructed by this class have initialize/assertInitialized".
// We intersect that with TBase below so the returned class keeps the original
// static side and generic DurableObject constructor shape.
type Constructor<T = object> = abstract new (...args: any[]) => T;

export type NamedInit = {
  /**
   * Durable Object names come from `namespace.getByName(name)`.
   *
   * The initialize mixin stores the name alongside the rest of the init params
   * and verifies it against `ctx.id.name`, so a stub for one name cannot
   * initialize storage for another name by mistake.
   */
  name: string;
};

/**
 * Callers usually already passed `name` to `getInitializedDoStub()`, so the
 * helper accepts init params without `name` and fills it in itself.
 *
 * The `InitParams extends unknown ? ... : never` wrapper makes this work for
 * unions one variant at a time instead of flattening the union first.
 *
 * Example:
 *
 *   type Init =
 *     | { name: string; kind: "team"; teamId: string }
 *     | { name: string; kind: "user"; userId: string };
 *
 *   { kind: "team", teamId: "team-a" } satisfies InitializeInput<Init>;
 *   { kind: "user", userId: "user-a" } satisfies InitializeInput<Init>;
 *
 * Without the distributive wrapper, the variant-specific fields are much
 * easier to accidentally weaken when `name` is omitted.
 */
export type InitializeInput<InitParams extends NamedInit> = InitParams extends unknown
  ? Omit<InitParams, "name"> & Partial<Pick<InitParams, "name">>
  : never;

export interface InitializeMembers<InitParams extends NamedInit> {
  initialize(params: InitParams): Promise<InitParams>;
  assertInitialized(): InitParams;
}

type DurableObjectBranded = {
  /**
   * `DurableObjectNamespace<T>` is meant to contain real Durable Object
   * instances, not arbitrary objects that happen to implement `initialize()`.
   * Cloudflare's DurableObject instance type includes this brand, so requiring
   * it keeps `getInitializedDoStub({ namespace, ... })` tied to actual DO
   * namespaces.
   */
  __DURABLE_OBJECT_BRAND: never;
};

type InitParamsOf<TInstance> =
  TInstance extends InitializeMembers<infer InitParams> ? InitParams : never;

type HasOnlyName<InitParams extends NamedInit> = keyof Omit<InitParams, "name"> extends never
  ? true
  : false;

type GetInitializedDoStubOptions<
  TInstance extends DurableObjectBranded & InitializeMembers<NamedInit>,
> = {
  namespace: DurableObjectNamespace<TInstance>;
  name: string;
} & (HasOnlyName<InitParamsOf<TInstance>> extends true
  ? { initParams?: InitializeInput<InitParamsOf<TInstance>> }
  : { initParams: InitializeInput<InitParamsOf<TInstance>> });

/**
 * Type-only protected surface.
 *
 * Mixins cannot add protected members through an interface, so this abstract
 * class is only used in the returned constructor type. It lets subclasses see
 * `this.initParams`, while external callers cannot.
 *
 * Example:
 *
 *   class Room extends RoomBase<Env> {
 *     owner() {
 *       return this.initParams.ownerUserId;
 *     }
 *   }
 *
 *   room.initParams; // TypeScript error outside the subclass.
 *
 * The getter body should never run. The real runtime getter is implemented by
 * `InitializeMixin` below.
 */
export abstract class InitializeProtected<InitParams extends NamedInit> {
  protected get initParams(): InitParams {
    throw new Error("InitializeProtected is type-only and should never run.");
  }
}

export type WithInitializeResult<
  TBase extends DurableObjectConstructor,
  InitParams extends NamedInit,
> =
  // Preserve the original class value. This is what keeps Cloudflare's
  // `class Room extends RoomBase<Env>` style working after the mixin wraps
  // `DurableObject`.
  TBase &
    // Add the instance members introduced by this mixin. The protected getter
    // has to come from `InitializeProtected` because protected members cannot
    // be expressed with an interface.
    //
    // Benefit:
    //
    //   const RoomBase = withInitialize<RoomInit>()(DurableObject);
    //   class Room extends RoomBase<Env> {
    //     send() { return this.initParams.ownerUserId; } // typed
    //   }
    //
    // But outside the subclass, `room.initParams` is still a TS error.
    Constructor<InitializeMembers<InitParams> & InitializeProtected<InitParams>>;

const INITIALIZE_STORAGE_KEY = "__mixin_initialize.params.v1";

export class NotInitializedError extends Error {
  constructor() {
    super("Durable Object has not been initialized. Call initialize(params) first.");
    this.name = "NotInitializedError";
  }
}

export class InitializeNameMismatchError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(
      actual === undefined
        ? `Cannot initialize object named "${expected}" because ctx.id.name is undefined. Use namespace.getByName(name) or namespace.idFromName(name).`
        : `Cannot initialize object named "${actual}" with params.name="${expected}".`,
    );
    this.name = "InitializeNameMismatchError";
  }
}

export class InitializeParamsMismatchError extends Error {
  constructor(name: string) {
    super(`Durable Object named "${name}" has already been initialized with different params.`);
    this.name = "InitializeParamsMismatchError";
  }
}

export function withInitialize<InitParams extends NamedInit>() {
  return function <TBase extends DurableObjectConstructor>(
    Base: TBase,
  ): WithInitializeResult<TBase, InitParams> {
    abstract class InitializeMixin extends Base implements InitializeMembers<InitParams> {
      #initParams: InitParams | undefined;

      constructor(...args: any[]) {
        super(...args);

        // This utility is intentionally for SQLite-backed Durable Objects.
        // Their synchronous KV API lets us hydrate cached init params during
        // construction without `blockConcurrencyWhile`, because no async storage
        // call is needed before requests can run.
        // https://developers.cloudflare.com/durable-objects/api/storage-api/#synchronous-kv-api
        this.#initParams = this.ctx.storage.kv.get<InitParams>(INITIALIZE_STORAGE_KEY);
      }

      /**
       * Protected subclass convenience.
       *
       * Throws synchronously if initialize() has not run.
       */
      protected get initParams(): InitParams {
        return this.assertInitialized();
      }

      async initialize(params: InitParams): Promise<InitParams> {
        if (!params.name) {
          throw new Error("initialize(params) requires a non-empty params.name.");
        }

        const objectName = this.ctx.id.name;

        if (objectName !== params.name) {
          throw new InitializeNameMismatchError(params.name, objectName);
        }

        const existing = this.ctx.storage.kv.get<InitParams>(INITIALIZE_STORAGE_KEY);

        if (existing !== undefined) {
          // Repeated initialization is allowed only when the full params match.
          // This makes the helper idempotent across cold starts and retrying
          // callers, while still rejecting attempts to mutate immutable init
          // state after the object exists.
          if (!areInitializeParamsEqual(existing, params)) {
            throw new InitializeParamsMismatchError(params.name);
          }

          this.#initParams = existing;
          return existing;
        }

        this.ctx.storage.kv.put(INITIALIZE_STORAGE_KEY, params);
        this.#initParams = params;

        return params;
      }

      assertInitialized(): InitParams {
        if (this.#initParams === undefined) {
          throw new NotInitializedError();
        }

        return this.#initParams;
      }
    }

    // TypeScript cannot prove that a generic class-expression mixin preserves
    // both Base's static side and the protected `initParams` surface. The cast
    // is the boundary where we state the runtime shape implemented above.
    return InitializeMixin as unknown as WithInitializeResult<TBase, InitParams>;
  };
}

/**
 * Returns a named Durable Object stub after calling `initialize()`.
 *
 * If the init shape is only `{ name: string }`, callers can omit `initParams`:
 *
 *   getInitializedDoStub({ namespace, name: "room-a" });
 *
 * If the init shape has required fields beyond `name`, callers must pass them:
 *
 *   getInitializedDoStub({
 *     namespace,
 *     name: "room-a",
 *     initParams: { ownerUserId: "user-a" },
 *   });
 *
 * This keeps the helper honest: a function named `getInitializedDoStub()`
 * should not be able to return a stub without the data required to initialize
 * it.
 */
export async function getInitializedDoStub<
  TInstance extends DurableObjectBranded & InitializeMembers<NamedInit>,
>(options: GetInitializedDoStubOptions<TInstance>) {
  const { namespace, name, initParams } = options;
  const stub = namespace.getByName(name);

  // The options type only permits omitted initParams for name-only init shapes.
  // After destructuring, TypeScript no longer carries that conditional fact, so
  // `{}` is the runtime default and `name` is added before initialize() runs.
  const input = (initParams ?? {}) as InitializeInput<InitParamsOf<TInstance>>;

  if (input.name !== undefined && input.name !== name) {
    throw new Error(`initParams.name must match name: expected "${name}", got "${input.name}".`);
  }

  // Durable Object RPC methods are exposed on the stub, but the stub type
  // cannot infer the exact InitParams from the options object after the
  // conditional `initParams` handling above. Keep the cast local and immediately
  // call the public `initialize()` RPC with the name-filled params.
  await (stub as unknown as InitializeMembers<InitParamsOf<TInstance>>).initialize({
    ...input,
    name,
  } as unknown as InitParamsOf<TInstance>);

  return stub;
}

function areInitializeParamsEqual<InitParams extends NamedInit>(
  left: InitParams,
  right: InitParams,
): boolean {
  // Init params are expected to be plain structured data. This comparison is
  // deliberately small and order-insensitive for object keys, which is enough
  // for the JSON-like init shapes used by these mixins.
  return deepEqual(left, right);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => deepEqual(value, right[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();

  if (!deepEqual(leftKeys, rightKeys)) {
    return false;
  }

  return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
}
