/// <reference types="@cloudflare/workers-types" />

import { dequal } from "dequal/lite";
import { z } from "zod";
import type {
  Constructor,
  DurableObjectClass,
  DurableObjectConstructor,
  MembersOf,
  ReqEnvOf,
  StaticSide,
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
}

type LifecycleHook<StructuredName extends LifecycleStructuredName> = (
  structuredName: StructuredName,
) => void | Promise<void>;

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

type StructuredNameOf<TInstance> =
  TInstance extends LifecycleHooksMembers<infer StructuredName> ? StructuredName : never;

type InitialStateOf<TInstance> =
  TInstance extends LifecycleHooksMembers<LifecycleStructuredName, infer InitialState>
    ? InitialState
    : undefined;

type GetOrInitializeDoStubOptions<TInstance extends DurableObjectBranded> = {
  namespace: DurableObjectNamespace<TInstance>;
  name: string | StructuredNameOf<TInstance>;
} & ([InitialStateOf<TInstance>] extends [undefined]
  ? {
      initialState?: never;
    }
  : {
      initialState: InitialStateOf<TInstance>;
    });

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
> =
  // Preserve the generic Durable Object constructor so this remains legal:
  //
  //   const RoomBase = withLifecycleHooks({ nameSchema: RoomName })(withDurableObjectCore(DurableObject));
  //   class Room extends RoomBase<Env> {}
  StaticSide<TBase> &
    DurableObjectClass<
      ReqEnvOf<TBase>,
      MembersOf<TBase> &
        LifecycleHooksMembers<StructuredName, InitialState> &
        LifecycleHooksProtected<StructuredName, InitialState>
    > &
    // Add the instance members introduced by this mixin. The protected getters
    // have to come from `LifecycleHooksProtected` because protected members
    // cannot be expressed with an interface.
    Constructor<
      LifecycleHooksMembers<StructuredName, InitialState> &
        LifecycleHooksProtected<StructuredName, InitialState>
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
 * Public methods: `initialize()`, `ensureStarted()`, and `assertInitialized()`.
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
export function withLifecycleHooks<
  StructuredName extends LifecycleStructuredName = string,
  InitialState = undefined,
>(options?: {
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
}) {
  const nameSchema = (options?.nameSchema ?? z.string()) as z.ZodType<StructuredName>;
  const initialStateSchema = options?.initialStateSchema as z.ZodType<InitialState> | undefined;

  return function <TBase extends DurableObjectClass>(
    Base: TBase & Constructor<DurableObjectCoreProtected>,
  ): WithLifecycleHooksResult<TBase, StructuredName, InitialState> {
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
      InitialState
    >;
  };
}

/**
 * Returns a named Durable Object stub after calling `initialize({ name })`.
 *
 * `name` may be either a raw string Durable Object name or the structured-name
 * object accepted by the target Durable Object's lifecycle schema. Object names
 * are serialized as bare canonical JSON before `namespace.getByName(name)`.
 */
export async function getOrInitializeDoStub<TInstance extends DurableObjectBranded>(
  options: GetOrInitializeDoStubOptions<TInstance>,
): Promise<DurableObjectStub<TInstance>> {
  if (options.name === undefined) {
    throw new Error("getOrInitializeDoStub() requires name.");
  }

  const name = deriveDurableObjectNameFromStructuredName({
    structuredName: options.name,
  });
  const stub = options.namespace.getByName(name);

  // Durable Object RPC methods are exposed on the stub, but the local variable
  // cannot carry the exact structured-name generic after Cloudflare's namespace
  // wrapper. Keep the cast local to the lifecycle method and return the original
  // typed stub.
  await (
    stub as unknown as LifecycleHooksMembers<StructuredNameOf<TInstance>, InitialStateOf<TInstance>>
  ).initialize({
    name,
    initialState: options.initialState,
  });

  return stub;
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

  return canonicalFlatNameJson(options.structuredName);
}

function canonicalFlatNameJson(value: Record<string, LifecycleStructuredNamePrimitive>): string {
  return JSON.stringify(canonicalizeStructuredNameRecord(value));
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
