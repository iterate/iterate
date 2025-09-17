import { z } from "zod/v4";
import { passThroughArgsSchema } from "../utils/pass-through-args.ts";
import type { Prettify } from "../utils/type-helpers.ts";

const BaseCallable = z.object({
  /**
   * This is a custom type that is used to infer the input and output types of the callable.
   * This carries no runtime value, it is only used to infer the types of the callable.
   */
  $infer: z.custom<{
    Input: unknown;
    Output: unknown;
  }>(),
  passThroughArgs: passThroughArgsSchema,
});

// TODO input/output should be constrained to being Record<string, JSONSerializable> so they can be merged with pass through args
export type CreateCallable<T, Input, Output> = Prettify<
  (T extends { $infer: unknown } ? Omit<T, "$infer"> : T) & {
    $infer: {
      Input: Input;
      Output: Output;
    };
  }
>;

export type Branded<Brand extends string, Value = string> = Value & z.$brand<Brand>;

export const NoopCallable = BaseCallable.extend({
  type: z.literal("NOOP"),
});

export type NoopCallable = z.infer<typeof NoopCallable>;

export const WorkerProcedureCallable = BaseCallable.extend({
  type: z.literal("WORKER_PROCEDURE"),
  workerName: z.string().brand("WorkerName"),
  procedureName: z.string().brand("WorkerProcedureName"),
});

export type WorkerProcedureCallable = z.infer<typeof WorkerProcedureCallable>;

export const WorkflowEventCallable = BaseCallable.extend({
  type: z.literal("WORKFLOW_EVENT"),
  workerName: z.string().brand("WorkerName"),
  workflowClassName: z.string().brand("WorkflowClassName"),
  workflowId: z.string(),
  eventType: z.string(),
});

export type WorkflowEventCallable = z.infer<typeof WorkflowEventCallable>;

export const durableObjectCallableSchemaWithId = BaseCallable.extend({
  type: z.literal("DURABLE_OBJECT_PROCEDURE"),
  workerName: z.string().brand("WorkerName"),
  durableObjectClassName: z.string().brand("DurableObjectClassName"),
  durableObjectId: z.string().brand("DurableObjectId"),
  procedureName: z.string().brand("DurableObjectProcedureName"),
});

export const durableObjectCallableSchemaWithName = durableObjectCallableSchemaWithId
  .omit({
    durableObjectId: true,
  })
  .extend({
    durableObjectName: z.string().brand("DurableObjectName"),
    durableObjectId: z.undefined().optional(), // Enforces that only one of id or name is provided
  });

export const DurableObjectCallable = z.union([
  durableObjectCallableSchemaWithId,
  durableObjectCallableSchemaWithName,
]);

export type DurableObjectCallable = z.infer<typeof DurableObjectCallable>;

export const TrpcProcedureCallable = BaseCallable.extend({
  type: z.literal("TRPC_PROCEDURE"),
  workerName: z.string().brand("WorkerName"),
  trpcProcedurePath: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
});

export type TrpcProcedureCallable = z.infer<typeof TrpcProcedureCallable>;

export const UrlCallable = BaseCallable.extend({
  type: z.literal("URL_CALLABLE"),
  url: z.string(),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]),
  headers: z.record(z.string(), z.string()).default({}),
});

export type UrlCallable = z.infer<typeof UrlCallable>;

export const SerializedCallable = z.union([
  NoopCallable,
  WorkerProcedureCallable,
  WorkflowEventCallable,
  DurableObjectCallable,
  TrpcProcedureCallable,
  UrlCallable,
]);

export type SerializedCallable = z.infer<typeof SerializedCallable>;
