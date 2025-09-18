import type { AnyRouter, AnyProcedure } from "@trpc/server";
import type {
  FlattenObject,
  PathToInput,
  PathToOutput,
  MergeTrpcRouters,
  JSONSerializable as _JSONSerializable,
} from "../utils/type-helpers.ts";
import type {
  Branded,
  CreateCallable,
  DurableObjectCallable,
  TrpcProcedureCallable,
  UrlCallable as _UrlCallable,
  WorkerProcedureCallable,
  WorkflowEventCallable as _WorkflowEventCallable,
} from "./callable.ts";
import type { SerializedCallableToolSpec, ToolSpec } from "./tool-schemas.ts";

/*
 * Type utilities that mirror the router shape and expose a fluent builder that ends with
 * `.passThroughArgs()` producing a `SerializedCallable` for a TRPC procedure.
 */

// A helper type for router recorxzds as suggested by trpc maintainer
export interface RouterRecord {
  [key: string]: AnyProcedure | RouterRecord;
}

// Recursively build builder object for nested routers & procedures
export type TrpcCallableBuilder<
  TrpcRouter extends AnyRouter,
  Record extends RouterRecord = TrpcRouter["_def"]["record"],
  Prefix extends string = "",
> = {
  [K in keyof Record]: Record[K] extends RouterRecord
    ? // Nested router – recurse deeper
      TrpcCallableBuilder<
        TrpcRouter,
        Record[K],
        Prefix extends "" ? `${Extract<K, string>}` : `${Prefix}.${Extract<K, string>}`
      >
    : Record[K] extends AnyProcedure
      ? ProcedureCallableBuilder<
          TrpcRouter,
          Prefix extends "" ? `${Extract<K, string>}` : `${Prefix}.${Extract<K, string>}`
        >
      : never;
};

// Builder exposed when a procedure is reached – allows .passThroughArgs({})
export type ProcedureCallableBuilder<TrpcRouter extends AnyRouter, FullPath extends string> = {
  build: <
    Args extends Partial<
      PathToInput<TrpcRouter, FullPath & keyof FlattenObject<TrpcRouter["_def"]["procedures"]>>
    >,
  >(options?: {
    passThroughArgs?: Args;
    headers?: Record<string, string>;
  }) => CreateCallable<
    TrpcProcedureCallable,
    Args | undefined,
    PathToOutput<TrpcRouter, FullPath & keyof FlattenObject<TrpcRouter["_def"]["procedures"]>>
  >;
  toolSpec: (
    options?: Partial<SerializedCallableToolSpec> & {
      passThroughArgs?: unknown;
      headers?: Record<string, string>;
    },
  ) => SerializedCallableToolSpec;
};

type DurableObjectMethodToCallables<Object extends object> = {
  [K in keyof Object]: Object[K] extends (...args: any[]) => any
    ? {
        build: (options: {
          durableObjectName: string;
          passThroughArgs?: Partial<Parameters<Object[K]>[0]>;
        }) => DurableObjectCallable & {
          $infer: {
            Input: Parameters<Object[K]>[0];
            Output: Awaited<ReturnType<Object[K]>>;
          };
        };
      }
    : never;
};

type WorkerProcedureMethodToCallables<Object extends object> = {
  [K in keyof Object]: Object[K] extends (...args: any[]) => any
    ? {
        build: (options?: {
          passThroughArgs?: Partial<Parameters<Object[K]>[0]>;
        }) => WorkerProcedureCallable & {
          $infer: {
            Input: Parameters<Object[K]>[0];
            Output: Awaited<ReturnType<Object[K]>>;
          };
        };
        toolSpec: (options?: {
          passThroughArgs?: Partial<Parameters<Object[K]>[0]>;
          headers?: Record<string, string>;
        }) => ToolSpec;
      }
    : never;
};

export function makeTrpcCallable<TRouters extends Record<string, AnyRouter>>(
  headers?: Record<string, string>,
): TrpcCallableBuilder<MergeTrpcRouters<TRouters>> {
  // runtime implementation using proxy accumulating path keys
  const createProxy = (pathParts: string[]): any =>
    new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "build") {
            const serviceName = pathParts.shift();
            if (!serviceName) {
              throw new Error("Service name is required");
            }
            return (options?: { passThroughArgs?: unknown; headers?: Record<string, string> }) => ({
              type: "TRPC_PROCEDURE",
              workerName: serviceName,
              trpcProcedurePath: pathParts.join("."),
              passThroughArgs: options?.passThroughArgs ?? {},
              headers: { ...headers, ...options?.headers },
            });
          } else if (prop === "toolSpec") {
            const serviceName = pathParts.shift();
            if (!serviceName) {
              throw new Error("Service name is required");
            }
            // passThroughArgs is a convenience here for callable.passThroughArgs
            return (
              options?: Partial<SerializedCallableToolSpec> & {
                passThroughArgs?: unknown;
                headers?: Record<string, string>;
              },
            ) => {
              const { passThroughArgs, callable, ...rest } = options ?? {};
              return {
                ...(rest ?? {}),
                type: "serialized_callable_tool",
                callable: {
                  ...(callable ?? {}),
                  type: "TRPC_PROCEDURE",
                  workerName: serviceName,
                  trpcProcedurePath: pathParts.join("."),
                  passThroughArgs: passThroughArgs ?? {},
                  headers: { ...headers, ...options?.headers },
                },
              };
            };
          }
          return createProxy([...pathParts, prop]);
        },
      },
    );
  return createProxy([]) as TrpcCallableBuilder<MergeTrpcRouters<TRouters>>;
}

export const makeDurableObjectCallable = <Object extends object>(
  workerName: string,
  objectClassName: string,
) => {
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        // As durable object methods are only one level deep, we can just return the build method
        return {
          build: (options: { durableObjectName: string; passThroughArgs?: any }) => {
            return {
              type: "DURABLE_OBJECT_PROCEDURE",
              workerName: workerName as Branded<"WorkerName">,
              durableObjectClassName: objectClassName as Branded<"DurableObjectClassName">,
              procedureName: prop as Branded<"DurableObjectProcedureName">,
              durableObjectName: options.durableObjectName as Branded<"DurableObjectName">,
              passThroughArgs: options?.passThroughArgs ?? {},
              $infer: {
                Input: null,
                Output: null,
              },
            } satisfies DurableObjectCallable;
          },
        };
      },
    },
  ) as DurableObjectMethodToCallables<Object>;
};

export const makeWorkerProcedureCallable = <Object extends object>(workerName: string) => {
  return new Proxy(
    {},
    {
      get(_target, prop: string) {
        // As worker procedures are only one level deep, we can just return the build method
        return {
          build: (options?: { passThroughArgs?: any }) => {
            return {
              type: "WORKER_PROCEDURE",
              workerName: workerName as Branded<"WorkerName">,
              procedureName: prop as Branded<"WorkerProcedureName">,
              passThroughArgs: options?.passThroughArgs ?? {},
              $infer: { Input: null, Output: null },
            } satisfies WorkerProcedureCallable;
          },
        };
      },
    },
  ) as WorkerProcedureMethodToCallables<Object>;
};
