/// <reference types="@cloudflare/workers-types" />

import { dequal } from "dequal/lite";
import { z } from "zod";
import type {
  Constructor,
  DurableObjectClass,
  DurableObjectConstructor,
  DurableObjectMixinResult,
  ReqEnvOf,
} from "./mixin-types.ts";
import type { DurableObjectCoreProtected } from "./with-durable-object-core.ts";

export type LifecycleStructuredNamePrimitive = string | number | boolean | null;
export type LifecycleStructuredName = string | Record<string, LifecycleStructuredNamePrimitive>;
export type LifecycleInitialStatePrimitive = string | number | boolean | null;
export type LifecycleInitialState =
  | LifecycleInitialStatePrimitive
  | readonly LifecycleInitialState[]
  | {
      readonly [key: string]: LifecycleInitialState;
    };

export type LifecycleInitializeInput<InitialState = undefined> = {
  /**
   * The actual Cloudflare Durable Object string name used with
   * `namespace.getByName(name)`.
   */
  name: string;
} & ([InitialState] extends [undefined]
  ? {
      initialState?: never;
    }
  : {
      /**
       * Optional on repeat calls, but required the first time a Durable Object
       * with an initialStateSchema is initialized.
       */
      initialState?: InitialState;
    });

export interface LifecycleHooksMembers<
  StructuredName extends LifecycleStructuredName = string,
  InitialState = undefined,
> {
  initialize(input: LifecycleInitializeInput<InitialState>): Promise<StructuredName>;
  assertInitialized(): StructuredName;
  ensureStarted(): Promise<StructuredName>;
  /**
   * Returns this Durable Object's D1 catalog row, or `null` when D1 cataloging
   * is explicitly disabled, the object has not been initialized, the
   * background D1 write has not run yet, or the mixin-owned tables have not
   * been created yet.
   */
  getD1ObjectCatalogRecord(): Promise<D1ObjectCatalogRecord<StructuredName> | null>;
}

type LifecycleHook<StructuredName extends LifecycleStructuredName> = (
  structuredName: StructuredName,
) => void | Promise<void>;

type StructuredNameOf<TInstance> =
  TInstance extends LifecycleHooksMembers<infer StructuredName> ? StructuredName : never;

type InitialStateOf<TInstance> =
  TInstance extends LifecycleHooksMembers<LifecycleStructuredName, infer InitialState>
    ? InitialState
    : undefined;

export type D1ObjectCatalogRecord<StructuredName extends LifecycleStructuredName> = {
  class: string;
  name: string;
  id: string;
  structuredName: StructuredName;
  createdAt: string;
  lastWokenAt: string;
};

export type D1ObjectCatalogIndexValue = string | number | readonly (string | number)[];

export type D1ObjectCatalogIndexDefinitions<StructuredName extends LifecycleStructuredName> =
  Record<string, (structuredName: StructuredName) => D1ObjectCatalogIndexValue>;

export type D1ObjectCatalogOptions<StructuredName extends LifecycleStructuredName, Env> = {
  className: string;
  getDatabase(env: Env): D1Database;
  indexes?: D1ObjectCatalogIndexDefinitions<StructuredName>;
};

/**
 * Type-only protected surface.
 *
 * Mixins cannot add protected members through an interface, so this abstract
 * class is only used in the returned constructor type. It lets subclasses see
 * `this.name` and `this.structuredName`, while external callers cannot.
 *
 * `this.name` is the Cloudflare Durable Object string name. `this.structuredName`
 * is the typed value the app treats as the name's structure.
 */
export abstract class LifecycleHooksProtected<
  StructuredName extends LifecycleStructuredName = string,
  InitialState = undefined,
> {
  protected get name(): string {
    throw new Error("LifecycleHooksProtected is type-only and should never run.");
  }

  protected get structuredName(): StructuredName {
    throw new Error("LifecycleHooksProtected is type-only and should never run.");
  }

  protected get initialState(): InitialState {
    throw new Error("LifecycleHooksProtected is type-only and should never run.");
  }

  protected registerOnFirstInitialize(_fn: LifecycleHook<StructuredName>): void {
    throw new Error("LifecycleHooksProtected is type-only and should never run.");
  }

  protected registerOnInstanceWake(_fn: LifecycleHook<StructuredName>): void {
    throw new Error("LifecycleHooksProtected is type-only and should never run.");
  }
}

type WithLifecycleHooksResult<
  TBase extends DurableObjectClass,
  StructuredName extends LifecycleStructuredName,
  InitialState,
  Env,
> =
  // Preserve the generic Durable Object constructor so this remains legal:
  //
  //   const RoomBase = withLifecycleHooks({
  //     d1ObjectCatalog: "none",
  //     nameSchema: RoomName,
  //   })(withDurableObjectCore(DurableObject));
  //   class Room extends RoomBase<Env> {}
  // Add the instance members introduced by this mixin. The protected getters
  // have to come from `LifecycleHooksProtected` because protected members
  // cannot be expressed with an interface.
  DurableObjectMixinResult<
    TBase,
    LifecycleHooksMembers<StructuredName, InitialState> &
      LifecycleHooksProtected<StructuredName, InitialState>,
    ReqEnvOf<TBase> & Env
  >;

const LIFECYCLE_NAME_STORAGE_KEY = "__mixin_lifecycle_hooks.name.v1";
const LIFECYCLE_INITIAL_STATE_STORAGE_KEY = "__mixin_lifecycle_hooks.initial_state.v1";
const FIRST_INITIALIZE_DONE_STORAGE_KEY = "__mixin_lifecycle_hooks.first_initialize_done.v1";

export class NotInitializedError extends Error {
  constructor() {
    super("Durable Object has not been initialized. Call initialize({ name }) first.");
    this.name = "NotInitializedError";
  }
}

export class InitializeNameMismatchError extends Error {
  constructor(expected: string, actual: string | undefined) {
    super(
      actual === undefined
        ? `Cannot verify Durable Object runtime name while initializing "${expected}" because ctx.id.name is undefined.`
        : `Cannot initialize object named "${actual}" with initialize({ name: "${expected}" }).`,
    );
    this.name = "InitializeNameMismatchError";
  }
}

export class InitializeStoredNameMismatchError extends Error {
  constructor(name: string) {
    super(`Durable Object named "${name}" has already been initialized with a different name.`);
    this.name = "InitializeStoredNameMismatchError";
  }
}

export class InitializeInitialStateRequiredError extends Error {
  constructor(name: string) {
    super(`Durable Object named "${name}" requires initialState the first time it is initialized.`);
    this.name = "InitializeInitialStateRequiredError";
  }
}

export class InitializeInitialStateMismatchError extends Error {
  constructor(name: string) {
    super(
      `Durable Object named "${name}" has already been initialized with different initialState.`,
    );
    this.name = "InitializeInitialStateMismatchError";
  }
}

/**
 * Adds named initialization and lifecycle hooks to a SQLite-backed Durable Object.
 *
 * Public methods: `initialize()`, `ensureStarted()`, `assertInitialized()`,
 * and `getD1ObjectCatalogRecord()`.
 * Protected subclass/mixin surface: `name`, `structuredName`,
 * `registerOnFirstInitialize()`, and `registerOnInstanceWake()`.
 *
 * Cloudflare Durable Objects are addressed by a string name. This mixin stores
 * that string as `this.name` and parses it through a Zod schema to expose
 * `this.structuredName`.
 *
 * `initialStateSchema` is a separate optional lane for immutable data that a
 * Durable Object needs before it can work, but that should not be encoded into
 * the Durable Object name. Supplying it means a name alone is not enough to
 * create a valid object: the first initialize call must also include
 * `initialState`, which is persisted and hydrated on later wakes.
 *
 * Some local Miniflare paths do not reliably expose the name from `ctx.id.name`,
 * so callers pass `initialize({ name })` and the mixin persists that string.
 * Persisting matters because alarms and other platform wakes do not go through
 * the caller-side initialization wrapper.
 *
 * Subclasses should not override `initialize()`. Put first-creation work in
 * `registerOnFirstInitialize()`, put per-JavaScript-instance wake work in
 * `registerOnInstanceWake()`, and call `ensureStarted()` before public methods
 * touch initialized state.
 */
type D1ObjectCatalogSetting<StructuredName extends LifecycleStructuredName, Env> =
  | "none"
  | D1ObjectCatalogOptions<StructuredName, Env>;

export function withLifecycleHooks<
  StructuredName extends LifecycleStructuredName = string,
  InitialState = undefined,
  Env = unknown,
>(options: {
  /**
   * Parses the Durable Object string name after a tiny convenience step:
   * names starting with "{" are JSON-parsed if possible before being passed
   * to this schema. Invalid JSON falls through as the original string, so the
   * schema remains the single validation authority.
   */
  nameSchema?: z.ZodType<StructuredName>;
  /**
   * Validates immutable creation-time data that should not be part of the
   * Durable Object name. The first initialize call must provide this state;
   * later calls may omit it, or may provide the exact same value.
   */
  initialStateSchema?: z.ZodType<InitialState>;
  /**
   * Explicit D1 object catalog configuration.
   *
   * Use `"none"` for Durable Objects that deliberately should not be listed in
   * D1. Otherwise lifecycle hooks own a best-effort D1 projection of initialized
   * objects. Catalog writes are intentionally detached from startup so Durable
   * Object creation does not depend on external D1 latency or availability.
   */
  d1ObjectCatalog: D1ObjectCatalogSetting<StructuredName, Env>;
}) {
  const nameSchema = (options.nameSchema ?? z.string()) as z.ZodType<StructuredName>;
  const initialStateSchema = options.initialStateSchema as z.ZodType<InitialState> | undefined;
  const d1ObjectCatalog = options.d1ObjectCatalog;

  return function <TBase extends DurableObjectClass>(
    Base: TBase & Constructor<DurableObjectCoreProtected>,
  ): WithLifecycleHooksResult<TBase, StructuredName, InitialState, Env> {
    const BaseWithCore = Base as unknown as DurableObjectConstructor<
      unknown,
      DurableObjectCoreProtected
    >;

    abstract class LifecycleHooksMixin
      extends BaseWithCore
      implements LifecycleHooksMembers<StructuredName, InitialState>
    {
      #name: string | undefined;
      #structuredName: StructuredName | undefined;
      #initialState: InitialState | undefined;
      #firstInitializeHooks: Array<LifecycleHook<StructuredName>> = [];
      #instanceWakeHooks: Array<LifecycleHook<StructuredName>> = [];
      #started = false;
      #instanceWakePromise: Promise<StructuredName> | undefined;
      #runningLifecycleHooks = false;

      constructor(...args: any[]) {
        super(...args);

        // Synchronous KV lets us hydrate name state during construction. We keep
        // this persisted primarily because alarms can wake an object without the
        // caller-side initialize wrapper running first.
        const name = this.getDurableObjectKv().get<string>(LIFECYCLE_NAME_STORAGE_KEY);
        if (name !== undefined) {
          this.#name = name;
          this.#structuredName = this.parseName(name);
        }

        const initialState = this.getDurableObjectKv().get<InitialState>(
          LIFECYCLE_INITIAL_STATE_STORAGE_KEY,
        );
        if (initialState !== undefined) {
          this.#initialState = this.parseInitialState(initialState);
        }

        if (d1ObjectCatalog !== "none") {
          this.registerOnInstanceWake((structuredName) => {
            this.scheduleD1ObjectCatalogUpsert(structuredName);
          });
        }
      }

      protected get name(): string {
        this.assertInitialized();
        return this.#name!;
      }

      protected get structuredName(): StructuredName {
        return this.assertInitialized();
      }

      protected get initialState(): InitialState {
        this.assertInitialized();
        return this.#initialState!;
      }

      /**
       * Register short work that should run after this Durable Object receives
       * its structured name for the first time.
       */
      protected registerOnFirstInitialize(fn: LifecycleHook<StructuredName>): void {
        if (this.#started || this.#instanceWakePromise !== undefined) {
          throw new Error(
            "registerOnFirstInitialize() must be called before lifecycle hooks start.",
          );
        }

        this.#firstInitializeHooks.push(fn);
      }

      /**
       * Register work that should run once per JavaScript Durable Object instance
       * wake, after the structured name exists and first-initialize hooks complete.
       */
      protected registerOnInstanceWake(fn: LifecycleHook<StructuredName>): void {
        if (this.#started || this.#instanceWakePromise !== undefined) {
          throw new Error("registerOnInstanceWake() must be called before lifecycle hooks start.");
        }

        this.#instanceWakeHooks.push(fn);
      }

      async initialize(input: LifecycleInitializeInput<InitialState>): Promise<StructuredName> {
        const runtimeName = this.getDurableObjectName();

        if (runtimeName !== undefined && runtimeName !== input.name) {
          throw new InitializeNameMismatchError(input.name, runtimeName);
        }

        const structuredName = this.parseName(input.name);
        const existing = this.getDurableObjectKv().get<string>(LIFECYCLE_NAME_STORAGE_KEY);
        const storedInitialState = this.getDurableObjectKv().get<InitialState>(
          LIFECYCLE_INITIAL_STATE_STORAGE_KEY,
        );

        if (existing !== undefined) {
          if (existing !== input.name) {
            throw new InitializeStoredNameMismatchError(existing);
          }

          this.#initialState = this.reconcileInitialState({
            name: input.name,
            inputInitialState: input.initialState,
            storedInitialState,
          });
          this.#name = existing;
          this.#structuredName = structuredName;
          return await this.ensureStarted();
        }

        this.#initialState = this.reconcileInitialState({
          name: input.name,
          inputInitialState: input.initialState,
          storedInitialState,
        });
        this.getDurableObjectKv().put(LIFECYCLE_NAME_STORAGE_KEY, input.name);
        if (this.#initialState !== undefined) {
          this.getDurableObjectKv().put(LIFECYCLE_INITIAL_STATE_STORAGE_KEY, this.#initialState);
        }
        this.#name = input.name;
        this.#structuredName = structuredName;

        return await this.ensureStarted();
      }

      assertInitialized(): StructuredName {
        if (this.#structuredName === undefined) {
          throw new NotInitializedError();
        }

        if (initialStateSchema !== undefined && this.#initialState === undefined) {
          throw new NotInitializedError();
        }

        return this.#structuredName;
      }

      async ensureStarted(): Promise<StructuredName> {
        const structuredName = this.assertInitialized();

        if (this.#started) {
          return structuredName;
        }

        // Instance wake hooks can legitimately call protected APIs from later
        // mixins. During startup we are already inside the gate, so re-entering
        // ensureStarted() should return the known structured name instead of
        // waiting on itself.
        if (this.#runningLifecycleHooks) {
          return structuredName;
        }

        this.#instanceWakePromise ??= (async () => {
          let initialized = structuredName;
          let hasStartupError = false;
          let startupError: unknown;

          await this.blockDurableObjectConcurrencyWhile(async () => {
            try {
              this.#runningLifecycleHooks = true;
              initialized = this.assertInitialized();

              const firstInitializeDone =
                this.getDurableObjectKv().get<boolean>(FIRST_INITIALIZE_DONE_STORAGE_KEY) ?? false;

              if (!firstInitializeDone) {
                for (const fn of this.#firstInitializeHooks) {
                  await fn.call(this, initialized);
                }

                this.getDurableObjectKv().put(FIRST_INITIALIZE_DONE_STORAGE_KEY, true);
              }

              for (const fn of this.#instanceWakeHooks) {
                await fn.call(this, initialized);
              }

              this.#started = true;
            } catch (error) {
              hasStartupError = true;
              startupError = error;
            } finally {
              this.#runningLifecycleHooks = false;
            }
          });

          // Do not throw from inside blockConcurrencyWhile. Cloudflare documents
          // that thrown errors reset the Durable Object, which is too harsh for
          // retryable lifecycle hooks.
          if (hasStartupError) {
            throw startupError;
          }

          return initialized;
        })();

        try {
          return await this.#instanceWakePromise;
        } catch (error) {
          this.#instanceWakePromise = undefined;
          throw error;
        }
      }

      async getD1ObjectCatalogRecord(): Promise<D1ObjectCatalogRecord<StructuredName> | null> {
        if (d1ObjectCatalog === "none") {
          return null;
        }

        const initialized = tryGetInitialized(this);
        if (!initialized) {
          return null;
        }

        return await getD1ObjectCatalogRecord<StructuredName>(
          d1ObjectCatalog.getDatabase(this.env as Env),
          {
            className: d1ObjectCatalog.className,
            name: this.name,
          },
        );
      }

      /**
       * Fire-and-log catalog update.
       *
       * D1 is outside the Durable Object's local transaction boundary. This
       * promise is deliberately detached and caught: startup can succeed and
       * callers can retry even when D1 is temporarily unavailable.
       *
       * Future non-creating stub lookups should treat this catalog as a
       * preflight: if no row exists, return "not found" without waking the
       * Durable Object. If a row exists, the lookup should call
       * `ensureStarted()`, not `initialize()`, so catalog/local-storage drift is
       * surfaced instead of silently recreating lifecycle state. Because
       * catalog writes are currently best-effort, catalog misses can be false
       * negatives until this mixin owns a durable retry task that eventually
       * guarantees the projection write.
       */
      private scheduleD1ObjectCatalogUpsert(structuredName: StructuredName) {
        if (d1ObjectCatalog === "none") {
          return;
        }

        void Promise.resolve()
          .then(() =>
            upsertD1ObjectCatalog({
              db: d1ObjectCatalog.getDatabase(this.env as Env),
              className: d1ObjectCatalog.className,
              id: this.getDurableObjectId().toString(),
              indexes: d1ObjectCatalog.indexes,
              name: this.name,
              structuredName,
            }),
          )
          .catch((error: unknown) => {
            console.error("[withLifecycleHooks] failed to upsert D1 object catalog row", error);
          });
      }

      private parseName(name: string): StructuredName {
        let valueForSchema: unknown = name;

        // Structured names are just bare canonical JSON object strings. When a
        // name looks like one, try to parse it before handing it to the schema.
        // If parsing fails, keep the raw string and let the schema produce the
        // validation error; there is no separate "decoded name" abstraction.
        if (name.startsWith("{")) {
          try {
            valueForSchema = JSON.parse(name);
          } catch {
            valueForSchema = name;
          }
        }

        return nameSchema.parse(valueForSchema);
      }

      private parseInitialState(value: unknown): InitialState {
        if (initialStateSchema === undefined) {
          return value as InitialState;
        }

        return initialStateSchema.parse(value);
      }

      private reconcileInitialState(input: {
        name: string;
        inputInitialState: InitialState | undefined;
        storedInitialState: InitialState | undefined;
      }): InitialState | undefined {
        if (initialStateSchema === undefined) {
          return undefined;
        }

        if (input.storedInitialState !== undefined) {
          const stored = this.parseInitialState(input.storedInitialState);
          if (
            input.inputInitialState !== undefined &&
            !dequal(stored, this.parseInitialState(input.inputInitialState))
          ) {
            throw new InitializeInitialStateMismatchError(input.name);
          }

          return stored;
        }

        if (input.inputInitialState === undefined) {
          throw new InitializeInitialStateRequiredError(input.name);
        }

        return this.parseInitialState(input.inputInitialState);
      }
    }

    // TypeScript cannot prove that a generic class-expression mixin preserves
    // both Base's static side and the protected name surface. The cast is the
    // boundary where we state the runtime shape implemented above.
    return LifecycleHooksMixin as unknown as WithLifecycleHooksResult<
      TBase,
      StructuredName,
      InitialState,
      Env
    >;
  };
}

/**
 * Returns a named Durable Object stub after starting lifecycle hooks.
 *
 * `name` may be either a raw string Durable Object name or the structured-name
 * object accepted by the target Durable Object's lifecycle schema. Object names
 * are serialized as bare canonical JSON before `namespace.getByName(name)`.
 *
 * `allowCreate: true` calls `initialize({ name })`, which creates lifecycle
 * state when it is missing. `allowCreate: false` asks the lifecycle object for
 * its D1 catalog record and returns `null` when there is no row or local
 * lifecycle state is missing. Because a raw `DurableObjectNamespace` does not
 * expose class-owned catalog metadata, this first version still wakes the named
 * Durable Object and cannot distinguish catalog/local-storage drift from "not
 * found". It deliberately treats the best-effort catalog as the current
 * existence check, so a delayed or failed catalog write can produce a false
 * miss. A future helper shape should move the D1 preflight outside the stub
 * wake, then call `ensureStarted()` on catalog hits so drift is surfaced.
 */
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

export async function getInitializedDoStub<
  TInstance extends DurableObjectBranded,
  const AllowCreate extends boolean,
>(
  options: {
    allowCreate: AllowCreate;
    namespace: DurableObjectNamespace<TInstance>;
    name: string | StructuredNameOf<TInstance>;
  } & (AllowCreate extends true
    ? [InitialStateOf<TInstance>] extends [undefined]
      ? {
          initialState?: never;
        }
      : {
          initialState: InitialStateOf<TInstance>;
        }
    : {
        initialState?: never;
      }),
): Promise<
  AllowCreate extends true ? DurableObjectStub<TInstance> : DurableObjectStub<TInstance> | null
> {
  if (options.name === undefined) {
    throw new Error("getInitializedDoStub() requires name.");
  }

  const name = deriveDurableObjectNameFromStructuredName({
    structuredName: options.name,
  });
  const stub = options.namespace.getByName(name);

  if (!options.allowCreate) {
    const lifecycleStub = stub as unknown as LifecycleHooksMembers<
      StructuredNameOf<TInstance>,
      InitialStateOf<TInstance>
    >;
    const catalogRecord = await lifecycleStub.getD1ObjectCatalogRecord();
    if (catalogRecord === null) {
      return null as AllowCreate extends true
        ? DurableObjectStub<TInstance>
        : DurableObjectStub<TInstance> | null;
    }

    try {
      await lifecycleStub.ensureStarted();
      return stub as AllowCreate extends true
        ? DurableObjectStub<TInstance>
        : DurableObjectStub<TInstance> | null;
    } catch (error) {
      if (isNotInitializedError(error)) {
        return null as AllowCreate extends true
          ? DurableObjectStub<TInstance>
          : DurableObjectStub<TInstance> | null;
      }

      throw error;
    }
  }

  // Durable Object RPC methods are exposed on the stub, but the local variable
  // cannot carry the exact structured-name generic after Cloudflare's namespace
  // wrapper. Keep the cast local to the lifecycle method and return the original
  // typed stub.
  await (
    stub as unknown as LifecycleHooksMembers<StructuredNameOf<TInstance>, InitialStateOf<TInstance>>
  ).initialize({
    name,
    initialState: "initialState" in options ? options.initialState : undefined,
  } as LifecycleInitializeInput<InitialStateOf<TInstance>>);

  return stub as AllowCreate extends true
    ? DurableObjectStub<TInstance>
    : DurableObjectStub<TInstance> | null;
}

export async function getD1ObjectCatalogRecord<StructuredName extends LifecycleStructuredName>(
  db: D1Database,
  input: {
    className: string;
    name: string;
  },
): Promise<D1ObjectCatalogRecord<StructuredName> | null> {
  try {
    const row = await db
      .prepare(
        `SELECT class, name, id, structured_name_json, created_at, last_woken_at
         FROM mixin_d1_object_catalog_objects
         WHERE class = ? AND name = ?
         LIMIT 1`,
      )
      .bind(input.className, input.name)
      .first<D1ObjectCatalogRow>();

    return row === null ? null : parseD1ObjectCatalogRow<StructuredName>(row);
  } catch (error) {
    if (isMissingD1ObjectCatalogTableError(error)) {
      return null;
    }

    throw error;
  }
}

export async function listD1ObjectCatalogRecordsByIndex<
  StructuredName extends LifecycleStructuredName,
>(
  db: D1Database,
  input: {
    className: string;
    indexName: string;
    indexValue: string | number;
  },
): Promise<D1ObjectCatalogRecord<StructuredName>[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT o.class, o.name, o.id, o.structured_name_json, o.created_at, o.last_woken_at
         FROM mixin_d1_object_catalog_indexes i
         JOIN mixin_d1_object_catalog_objects o
           ON o.class = i.class AND o.name = i.name
         WHERE i.class = ? AND i.index_name = ? AND i.index_value = ?
         ORDER BY o.created_at ASC, o.name ASC`,
      )
      .bind(input.className, input.indexName, String(input.indexValue))
      .all<D1ObjectCatalogRow>();

    return results.map((row) => parseD1ObjectCatalogRow<StructuredName>(row));
  } catch (error) {
    if (isMissingD1ObjectCatalogTableError(error)) {
      return [];
    }

    throw error;
  }
}

export async function listD1ObjectCatalogRecords<StructuredName extends LifecycleStructuredName>(
  db: D1Database,
  input: {
    className: string;
  },
): Promise<D1ObjectCatalogRecord<StructuredName>[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT class, name, id, structured_name_json, created_at, last_woken_at
         FROM mixin_d1_object_catalog_objects
         WHERE class = ?
         ORDER BY created_at ASC, name ASC`,
      )
      .bind(input.className)
      .all<D1ObjectCatalogRow>();

    return results.map((row) => parseD1ObjectCatalogRow<StructuredName>(row));
  } catch (error) {
    if (isMissingD1ObjectCatalogTableError(error)) {
      return [];
    }

    throw error;
  }
}

/**
 * @internal Prefer lifecycle-owned catalog writes through `d1ObjectCatalog`.
 * This remains exported for Durable Object bases that cannot use this mixin yet.
 */
export async function upsertD1ObjectCatalog<StructuredName extends LifecycleStructuredName>(input: {
  db: D1Database;
  className: string;
  id: string;
  indexes: D1ObjectCatalogIndexDefinitions<StructuredName> | undefined;
  name: string;
  structuredName: StructuredName;
}) {
  const now = new Date().toISOString();
  const indexEntries = getIndexEntries(input.indexes, input.structuredName);

  await input.db.batch([
    input.db.prepare(CREATE_D1_OBJECT_CATALOG_OBJECTS_TABLE_SQL),
    input.db.prepare(CREATE_D1_OBJECT_CATALOG_INDEXES_TABLE_SQL),
    input.db
      .prepare(
        `INSERT INTO mixin_d1_object_catalog_objects (
          class,
          name,
          id,
          structured_name_json,
          created_at,
          last_woken_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(class, name) DO UPDATE SET
          id = excluded.id,
          structured_name_json = excluded.structured_name_json,
          last_woken_at = excluded.last_woken_at`,
      )
      .bind(input.className, input.name, input.id, JSON.stringify(input.structuredName), now, now),
    input.db
      .prepare(
        `DELETE FROM mixin_d1_object_catalog_indexes
         WHERE class = ? AND name = ?`,
      )
      .bind(input.className, input.name),
    ...indexEntries.map((entry) =>
      input.db
        .prepare(
          `INSERT INTO mixin_d1_object_catalog_indexes (
            class,
            index_name,
            index_value,
            name
          )
          VALUES (?, ?, ?, ?)`,
        )
        .bind(input.className, entry.indexName, entry.indexValue, input.name),
    ),
  ]);
}

const CREATE_D1_OBJECT_CATALOG_OBJECTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS mixin_d1_object_catalog_objects (
      class TEXT NOT NULL,
      name TEXT NOT NULL,
      id TEXT NOT NULL,
      structured_name_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      last_woken_at TEXT NOT NULL,
      PRIMARY KEY (class, name)
    )`;

const CREATE_D1_OBJECT_CATALOG_INDEXES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS mixin_d1_object_catalog_indexes (
      class TEXT NOT NULL,
      index_name TEXT NOT NULL,
      index_value TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (class, index_name, index_value, name)
    )`;

type D1ObjectCatalogRow = {
  class: string;
  name: string;
  id: string;
  structured_name_json: string;
  created_at: string;
  last_woken_at: string;
};

function parseD1ObjectCatalogRow<StructuredName extends LifecycleStructuredName>(
  row: D1ObjectCatalogRow,
): D1ObjectCatalogRecord<StructuredName> {
  return {
    class: row.class,
    name: row.name,
    id: row.id,
    structuredName: JSON.parse(row.structured_name_json) as StructuredName,
    createdAt: row.created_at,
    lastWokenAt: row.last_woken_at,
  };
}

function getIndexEntries<StructuredName extends LifecycleStructuredName>(
  indexes: D1ObjectCatalogIndexDefinitions<StructuredName> | undefined,
  structuredName: StructuredName,
) {
  return Object.entries(indexes ?? {}).flatMap(([indexName, getValue]) => {
    const value = getValue(structuredName);
    const values = Array.isArray(value) ? value : [value];

    return values.map((indexValue) => ({
      indexName,
      indexValue: String(indexValue),
    }));
  });
}

function tryGetInitialized<StructuredName extends LifecycleStructuredName>(
  instance: LifecycleHooksMembers<StructuredName>,
) {
  try {
    instance.assertInitialized();
    return true;
  } catch (error) {
    if (isNotInitializedError(error)) {
      return false;
    }

    throw error;
  }
}

function isNotInitializedError(error: unknown) {
  if (error instanceof Error && error.name === "NotInitializedError") {
    return true;
  }

  if (error instanceof Error && error.message.includes("NotInitializedError")) {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "NotInitializedError"
  );
}

function isMissingD1ObjectCatalogTableError(error: unknown) {
  return (
    error instanceof Error && error.message.includes("no such table: mixin_d1_object_catalog_")
  );
}

/**
 * Deterministically derives a Durable Object string name from a structured name.
 */
export function deriveDurableObjectNameFromStructuredName(options: {
  structuredName: LifecycleStructuredName;
}): string {
  if (typeof options.structuredName === "string") {
    return options.structuredName;
  }

  return serializeDurableObjectStructuredName(options);
}

/**
 * Canonical JSON representation used for object structured-name identity.
 */
export function serializeDurableObjectStructuredName(options: {
  structuredName: LifecycleStructuredName;
}): string {
  if (typeof options.structuredName === "string") {
    return options.structuredName;
  }

  return JSON.stringify(canonicalizeStructuredNameRecord(options.structuredName));
}

function canonicalizeStructuredNameRecord(
  value: Record<string, unknown>,
): Record<string, LifecycleStructuredNamePrimitive> {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));

  for (const [key, entryValue] of entries) {
    if (
      entryValue !== null &&
      typeof entryValue !== "string" &&
      typeof entryValue !== "number" &&
      typeof entryValue !== "boolean"
    ) {
      throw new Error(
        `Durable Object structured name field "${key}" must be a string, number, boolean, or null.`,
      );
    }
  }

  return Object.fromEntries(entries) as Record<string, LifecycleStructuredNamePrimitive>;
}
