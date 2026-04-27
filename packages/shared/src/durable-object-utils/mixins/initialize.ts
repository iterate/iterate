/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from "cloudflare:workers";

type DurableObjectConstructor = abstract new (...args: any[]) => DurableObject;

type Constructor<T = object> = abstract new (...args: any[]) => T;

export type NamedInit = {
  name: string;
};

export type InitializeInput<InitParams extends NamedInit> = InitParams extends unknown
  ? Omit<InitParams, "name"> & Partial<Pick<InitParams, "name">>
  : never;

export interface InitializeMembers<InitParams extends NamedInit> {
  initialize(params: InitParams): Promise<InitParams>;
  assertInitialized(): InitParams;
}

type DurableObjectBranded = {
  __DURABLE_OBJECT_BRAND: never;
};

type InitParamsOf<TInstance> =
  TInstance extends InitializeMembers<infer InitParams> ? InitParams : never;

/**
 * Type-only protected surface.
 *
 * This lets subclasses see `this.initParams`, while external callers cannot.
 */
export abstract class InitializeProtected<InitParams extends NamedInit> {
  protected get initParams(): InitParams {
    throw new Error("InitializeProtected is type-only and should never run.");
  }
}

export type WithInitializeResult<
  TBase extends DurableObjectConstructor,
  InitParams extends NamedInit,
> = TBase & Constructor<InitializeMembers<InitParams> & InitializeProtected<InitParams>>;

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

        // SQLite-backed Durable Objects expose synchronous KV at `ctx.storage.kv`.
        // That keeps constructor hydration synchronous and avoids `blockConcurrencyWhile`.
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

    return InitializeMixin as unknown as WithInitializeResult<TBase, InitParams>;
  };
}

export async function getInitializedDoStub<
  TInstance extends DurableObjectBranded & InitializeMembers<NamedInit>,
>(options: {
  namespace: DurableObjectNamespace<TInstance>;
  name: string;
  initParams?: InitializeInput<InitParamsOf<TInstance>>;
}) {
  const { namespace, name, initParams } = options;
  const stub = namespace.getByName(name);

  if (initParams !== undefined) {
    const params = normalizeInitializeParams(name, initParams);

    await (stub as unknown as InitializeMembers<InitParamsOf<TInstance>>).initialize(params);
  }

  return stub;
}

function areInitializeParamsEqual<InitParams extends NamedInit>(
  left: InitParams,
  right: InitParams,
): boolean {
  return deepEqual(left, right);
}

function normalizeInitializeParams<InitParams extends NamedInit>(
  name: string,
  input: InitializeInput<InitParams>,
): InitParams {
  if (input.name !== undefined && input.name !== name) {
    throw new Error(
      `initializeParams.name must match getByName(name): expected "${name}", got "${input.name}".`,
    );
  }

  return {
    ...input,
    name,
  } as unknown as InitParams;
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
