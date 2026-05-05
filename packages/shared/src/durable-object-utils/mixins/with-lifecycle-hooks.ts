/// <reference types="@cloudflare/workers-types" />

import { dequal } from "dequal/lite";
import type {
  Constructor,
  DurableObjectClass,
  MembersOf,
  ReqEnvOf,
  RuntimeDurableObjectConstructor,
  StaticSide,
} from "./mixin-types.ts";

export type LifecycleInit = {
  /**
   * Durable Object names come from `namespace.getByName(name)`.
   *
   * The lifecycle hooks mixin stores the name alongside the rest of the init
   * params and verifies it against `ctx.id.name`, so a stub for one name cannot
   * initialize storage for another name by mistake.
   */
  name: string;
};

/**
 * Callers usually already passed `name` to `getOrInitializeDoStub()`, so the
 * helper accepts init params without `name` and fills it in itself.
 *
 * The `BaseInitParams extends unknown ? ... : never` wrapper makes this work for
 * unions one variant at a time instead of flattening the union first.
 *
 * Example:
 *
 *   type Init =
 *     | { name: string; kind: "team"; teamId: string }
 *     | { name: string; kind: "user"; userId: string };
 *
 *   { kind: "team", teamId: "team-a" } satisfies LifecycleInitInput<Init>;
 *   { kind: "user", userId: "user-a" } satisfies LifecycleInitInput<Init>;
 *
 * Without the distributive wrapper, the variant-specific fields are much
 * easier to accidentally weaken when `name` is omitted.
 */
export type LifecycleInitInput<BaseInitParams extends LifecycleInit> =
  BaseInitParams extends unknown
    ? Omit<BaseInitParams, "name"> & Partial<Pick<BaseInitParams, "name">>
    : never;

export interface LifecycleHooksMembers<InitParams extends LifecycleInit> {
  initialize(params: InitParams): Promise<InitParams>;
  assertInitialized(): InitParams;
  ensureStarted(): Promise<InitParams>;
}

type LifecycleHook<InitParams extends LifecycleInit> = (params: InitParams) => void | Promise<void>;

type DurableObjectBranded = {
  /**
   * `DurableObjectNamespace<T>` is meant to contain real Durable Object
   * instances, not arbitrary objects that happen to implement `initialize()`.
   * Cloudflare's DurableObject instance type includes this brand, so requiring
   * it keeps `getOrInitializeDoStub({ namespace, ... })` tied to actual DO
   * namespaces.
   */
  __DURABLE_OBJECT_BRAND: never;
};

type InitParamsOf<TInstance> =
  TInstance extends LifecycleHooksMembers<infer InitParams> ? InitParams : never;

type HasOnlyName<InitParams extends LifecycleInit> = keyof Omit<InitParams, "name"> extends never
  ? true
  : false;

type GetOrInitializeDoStubOptions<
  TInstance extends DurableObjectBranded & LifecycleHooksMembers<LifecycleInit>,
> =
  | ({
      namespace: DurableObjectNamespace<TInstance>;
      name: string;
    } & (HasOnlyName<InitParamsOf<TInstance>> extends true
      ? { initParams?: LifecycleInitInput<InitParamsOf<TInstance>> }
      : { initParams: LifecycleInitInput<InitParamsOf<TInstance>> }))
  | {
      namespace: DurableObjectNamespace<TInstance>;
      name?: never;
      initParams: LifecycleInitInput<InitParamsOf<TInstance>>;
    };

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
 * `LifecycleHooksMixin` below.
 */
export abstract class LifecycleHooksProtected<InitParams extends LifecycleInit> {
  protected get initParams(): InitParams {
    throw new Error("LifecycleHooksProtected is type-only and should never run.");
  }

  protected registerOnFirstInitialize(_fn: LifecycleHook<InitParams>): void {
    throw new Error("LifecycleHooksProtected is type-only and should never run.");
  }

  protected registerOnInstanceWake(_fn: LifecycleHook<InitParams>): void {
    throw new Error("LifecycleHooksProtected is type-only and should never run.");
  }
}

type WithLifecycleHooksResult<TBase extends DurableObjectClass, InitParams extends LifecycleInit> =
  // Preserve the generic Durable Object constructor so this remains legal:
  //
  //   const RoomBase = withLifecycleHooks<RoomInit>()(DurableObject);
  //   class Room extends RoomBase<Env> {}
  StaticSide<TBase> &
    DurableObjectClass<
      ReqEnvOf<TBase>,
      MembersOf<TBase> & LifecycleHooksMembers<InitParams> & LifecycleHooksProtected<InitParams>
    > &
    // Add the instance members introduced by this mixin. The protected getter
    // has to come from `LifecycleHooksProtected` because protected members cannot
    // be expressed with an interface.
    //
    // Benefit:
    //
    //   const RoomBase = withLifecycleHooks<RoomInit>()(DurableObject);
    //   class Room extends RoomBase<Env> {
    //     send() { return this.initParams.ownerUserId; } // typed
    //   }
    //
    // But outside the subclass, `room.initParams` is still a TS error.
    Constructor<LifecycleHooksMembers<InitParams> & LifecycleHooksProtected<InitParams>>;

const LIFECYCLE_PARAMS_STORAGE_KEY = "__mixin_lifecycle_hooks.params.v1";
const FIRST_INITIALIZE_DONE_STORAGE_KEY = "__mixin_lifecycle_hooks.first_initialize_done.v1";

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

/**
 * Adds named initialization and lifecycle hooks to a SQLite-backed Durable Object.
 *
 * Public methods: `initialize()`, `ensureStarted()`, and `assertInitialized()`.
 * Protected subclass/mixin surface: `initParams`, `registerOnFirstInitialize()`,
 * and `registerOnInstanceWake()`.
 *
 * Init params are persisted in local Durable Object storage, so they must be
 * values that can cross Durable Object RPC and survive storage serialization.
 * Store IDs/config here, then rebuild clients and other runtime objects from
 * `env` when the Durable Object starts.
 */
export function withLifecycleHooks<InitParams extends LifecycleInit>() {
  return function <TBase extends DurableObjectClass>(
    Base: TBase,
  ): WithLifecycleHooksResult<TBase, InitParams> {
    // See RuntimeDurableObjectConstructor docs for why this cast is needed to access protected ctx/env.
    const BaseWithDurableObject = Base as unknown as RuntimeDurableObjectConstructor;

    abstract class LifecycleHooksMixin
      extends BaseWithDurableObject
      implements LifecycleHooksMembers<InitParams>
    {
      #initParams: InitParams | undefined;
      #firstInitializeHooks: Array<LifecycleHook<InitParams>> = [];
      #instanceWakeHooks: Array<LifecycleHook<InitParams>> = [];
      #started = false;
      #instanceWakePromise: Promise<InitParams> | undefined;
      #runningLifecycleHooks = false;

      constructor(ctx: DurableObjectState, env: unknown) {
        super(ctx, env);

        // This utility is intentionally for SQLite-backed Durable Objects.
        // Their synchronous KV API lets us hydrate cached init params during
        // construction without `blockConcurrencyWhile`, because no async storage
        // call is needed before requests can run.
        // https://developers.cloudflare.com/durable-objects/api/storage-api/#synchronous-kv-api
        this.#initParams = this.ctx.storage.kv.get<InitParams>(LIFECYCLE_PARAMS_STORAGE_KEY);
      }

      /**
       * Protected subclass convenience.
       *
       * Throws synchronously if initialize() has not run.
       */
      protected get initParams(): InitParams {
        return this.assertInitialized();
      }

      /**
       * Register short work that should run after this Durable Object receives
       * init params for the first time.
       *
       * The "first" marker is persisted in the Durable Object's local storage,
       * not in external systems. A hook that writes to D1, R2, or another
       * service must still be idempotent because there is no transaction across
       * the DO's SQLite storage and that external service.
       */
      protected registerOnFirstInitialize(fn: LifecycleHook<InitParams>): void {
        if (this.#started || this.#instanceWakePromise !== undefined) {
          throw new Error(
            "registerOnFirstInitialize() must be called before lifecycle hooks start.",
          );
        }

        this.#firstInitializeHooks.push(fn);
      }

      /**
       * Register work that should run once per JavaScript Durable Object instance
       * wake, after init params exist and after first-initialize hooks complete.
       *
       * Hooks are awaited by `ensureStarted()`. If the work is best-effort, start
       * a separately caught promise and return quickly so the hook does not become
       * part of the object's readiness boundary. Cloudflare's Durable Object
       * `ctx.waitUntil()` exists for Worker API compatibility but does not extend
       * lifetime in Durable Objects.
       */
      protected registerOnInstanceWake(fn: LifecycleHook<InitParams>): void {
        if (this.#started || this.#instanceWakePromise !== undefined) {
          throw new Error("registerOnInstanceWake() must be called before lifecycle hooks start.");
        }

        this.#instanceWakeHooks.push(fn);
      }

      async initialize(params: InitParams): Promise<InitParams> {
        if (!params.name) {
          throw new Error("initialize(params) requires a non-empty params.name.");
        }

        // Cloudflare exposes `ctx.id.name` for objects addressed by
        // `namespace.getByName(name)` / `idFromName(name)`. The worker-pool
        // Miniflare tests exercise this same path, including the mismatch
        // branch, so we keep the production invariant instead of accepting an
        // unverifiable name when the runtime does not provide one.
        const objectName = this.ctx.id.name;

        if (objectName !== params.name) {
          throw new InitializeNameMismatchError(params.name, objectName);
        }

        const existing = this.ctx.storage.kv.get<InitParams>(LIFECYCLE_PARAMS_STORAGE_KEY);

        if (existing !== undefined) {
          // Repeated initialization is allowed only when the full params match.
          // This makes the helper idempotent across cold starts and retrying
          // callers, while still rejecting attempts to mutate immutable init
          // state after the object exists.
          if (!dequal(existing, params)) {
            throw new InitializeParamsMismatchError(params.name);
          }

          this.#initParams = existing;
          return await this.ensureStarted();
        }

        this.ctx.storage.kv.put(LIFECYCLE_PARAMS_STORAGE_KEY, params);
        this.#initParams = params;

        return await this.ensureStarted();
      }

      assertInitialized(): InitParams {
        if (this.#initParams === undefined) {
          throw new NotInitializedError();
        }

        return this.#initParams;
      }

      async ensureStarted(): Promise<InitParams> {
        const params = this.assertInitialized();

        if (this.#started) {
          return params;
        }

        // Instance wake hooks can legitimately call protected APIs from later mixins.
        // Those APIs usually call ensureStarted() because normal public/RPC calls
        // must not mutate scheduler/alarm state before lifecycle startup is done.
        //
        // During this exact window we are already inside the startup gate, so
        // waiting on #instanceWakePromise would deadlock: the hook waits for
        // startup, and startup waits for the hook. Returning the initialized
        // params is safe because blockConcurrencyWhile keeps external calls
        // behind the gate.
        if (this.#runningLifecycleHooks) {
          return params;
        }

        this.#instanceWakePromise ??= (async () => {
          let initialized = params;
          let hasStartupError = false;
          let startupError: unknown;

          await this.ctx.blockConcurrencyWhile(async () => {
            try {
              this.#runningLifecycleHooks = true;
              initialized = this.assertInitialized();

              const firstInitializeDone =
                this.ctx.storage.kv.get<boolean>(FIRST_INITIALIZE_DONE_STORAGE_KEY) ?? false;

              if (!firstInitializeDone) {
                for (const fn of this.#firstInitializeHooks) {
                  await fn.call(this, initialized);
                }

                this.ctx.storage.kv.put(FIRST_INITIALIZE_DONE_STORAGE_KEY, true);
              }

              for (const fn of this.#instanceWakeHooks) {
                await fn.call(this, initialized);
              }

              this.#started = true;
            } catch (error) {
              // JavaScript can throw any value, including `undefined`.
              // Keep an explicit boolean so `throw undefined` is still treated
              // as a real startup failure rather than the "no error captured"
              // sentinel.
              hasStartupError = true;
              startupError = error;
            } finally {
              this.#runningLifecycleHooks = false;
            }
          });

          // Do not throw from inside blockConcurrencyWhile. Cloudflare documents
          // that thrown errors reset the Durable Object, which is correct for
          // fatal constructor setup but too harsh for retryable lifecycle hooks.
          //
          // Capture and re-throw after the gate so initialize()/ensureStarted()
          // callers can catch and retry normally.
          // https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile
          if (hasStartupError) {
            throw startupError;
          }

          return initialized;
        })();

        try {
          return await this.#instanceWakePromise;
        } catch (error) {
          // Failed startup should be retryable. Without clearing the shared
          // promise, every later ensureStarted() would observe the same
          // rejected promise and the Durable Object would stay stuck until
          // eviction.
          this.#instanceWakePromise = undefined;
          throw error;
        }
      }
    }

    // TypeScript cannot prove that a generic class-expression mixin preserves
    // both Base's static side and the protected `initParams` surface. The cast
    // is the boundary where we state the runtime shape implemented above.
    return LifecycleHooksMixin as unknown as WithLifecycleHooksResult<TBase, InitParams>;
  };
}

/**
 * Returns a named Durable Object stub after calling `initialize()`.
 *
 * `initialize()` waits for `ensureStarted()`, so the returned stub has already
 * passed the lifecycle readiness boundary. The helper name stays focused on
 * caller intent: get this named object, initializing it if this is the first
 * call.
 *
 * If the init shape is only `{ name: string }`, callers can omit `initParams`:
 *
 *   getOrInitializeDoStub({ namespace, name: "room-a" });
 *
 * Durable Object names are durable identity, not display labels. Prefer stable
 * identifiers in names, such as database IDs, project IDs, or user IDs. Avoid
 * mutable slugs/titles unless changing the slug should deliberately create a
 * different Durable Object.
 *
 * If the init shape has required fields beyond `name`, callers must pass them:
 *
 *   getOrInitializeDoStub({
 *     namespace,
 *     name: "room-a",
 *     initParams: { ownerUserId: "user-a" },
 *   });
 *
 * This keeps the helper honest: it cannot return a stub without the data
 * required to initialize it.
 *
 * If `name` is omitted, the helper derives a stable name from `initParams`.
 * That keeps simple call sites concise while still storing the derived name
 * inside the Durable Object's persisted init params:
 *
 *   getOrInitializeDoStub({
 *     namespace,
 *     initParams: {
 *       projectId,
 *       roomSlug,
 *     },
 *   });
 *
 * Use `deriveDurableObjectNameFromInitParams()` directly when other code needs
 * the same generated name, for example before storing a callable that addresses
 * the object by `{ name }`.
 */
export async function getOrInitializeDoStub<
  TInstance extends DurableObjectBranded & LifecycleHooksMembers<LifecycleInit>,
>(options: GetOrInitializeDoStubOptions<TInstance>) {
  const { namespace } = options;
  const hasName = "name" in options && options.name !== undefined;
  const hasInitParams = "initParams" in options && options.initParams !== undefined;

  if (!hasName && !hasInitParams) {
    throw new Error("getOrInitializeDoStub() requires either name or initParams.");
  }

  const initParams = hasInitParams ? options.initParams : undefined;

  // The options type only permits omitted initParams for name-only init shapes.
  // After destructuring, TypeScript no longer carries that conditional fact, so
  // `{}` is the runtime default and `name` is added before initialize() runs.
  const input = (initParams ?? {}) as LifecycleInitInput<InitParamsOf<TInstance>>;
  const name =
    (hasName ? options.name : input.name) ??
    deriveDurableObjectNameFromInitParams({ initParams: input });
  const stub = namespace.getByName(name);

  if (input.name !== undefined && input.name !== name) {
    throw new Error(`initParams.name must match name: expected "${name}", got "${input.name}".`);
  }

  // Durable Object RPC methods are exposed on the stub, but the stub type
  // cannot infer the exact InitParams from the options object after the
  // conditional `initParams` handling above. Keep the cast local and immediately
  // call the public `initialize()` RPC with the name-filled params.
  await (stub as unknown as LifecycleHooksMembers<InitParamsOf<TInstance>>).initialize({
    ...input,
    name,
  } as unknown as InitParamsOf<TInstance>);

  return stub;
}

/**
 * Deterministically derives a Durable Object name from init params.
 *
 * This is intentionally boring and local: sort object keys, omit `undefined`
 * object fields, preserve array order, then prefix the canonical JSON. It is
 * not an index or lookup layer. It is just the default name used when
 * `getOrInitializeDoStub()` receives init params without an explicit name.
 */
export function deriveDurableObjectNameFromInitParams(options: { initParams: unknown }): string {
  return `init:${serializeDurableObjectInitParams(options)}`;
}

/**
 * Canonical JSON representation used for init-param-derived Durable Object identity.
 *
 * This keeps every caller on the same serialization rule: sort object keys,
 * omit `undefined` object fields, preserve array order, and stringify the
 * resulting JSON value.
 */
export function serializeDurableObjectInitParams(options: { initParams: unknown }): string {
  return canonicalJson(options.initParams);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(
    entries.map(([key, entryValue]) => [key, canonicalizeJsonValue(entryValue)]),
  );
}
