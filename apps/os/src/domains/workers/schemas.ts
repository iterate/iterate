import { z } from "zod";
import { normalizePath } from "../durable-object-names.ts";
import type {
  StatefulDynamicWorkerRef as StatefulWorkerRefType,
  StatelessDynamicWorkerRef as StatelessWorkerRefType,
  DynamicWorkerRef as WorkerRefType,
  DynamicWorkerSource as WorkerSourceType,
} from "../../types.ts";

const DURABLE_WORKER_KEY = /^[a-z][a-z0-9-]{0,62}$/;

const DynamicWorkerSource = z.discriminatedUnion("type", [
  z.strictObject({
    mainModule: z.string(),
    modules: z.record(z.string(), z.string()),
    type: z.literal("inline"),
  }),
  z.strictObject({
    repoPath: z.string(),
    sourcePath: z.string(),
    type: z.literal("repo"),
  }),
]) satisfies z.ZodType<WorkerSourceType, unknown>;

const WorkerRefBase = {
  path: z.string().transform(normalizePath),
  source: DynamicWorkerSource,
};

const StatelessDynamicWorkerRef = z.strictObject({
  ...WorkerRefBase,
  entrypoint: z.string().optional(),
  props: z.record(z.string(), z.json()).optional(),
  type: z.literal("stateless"),
}) satisfies z.ZodType<StatelessWorkerRefType, unknown>;

const StatefulDynamicWorkerRef = z.strictObject({
  ...WorkerRefBase,
  className: z.string(),
  durableWorkerKey: z.string().regex(DURABLE_WORKER_KEY),
  type: z.literal("stateful"),
}) satisfies z.ZodType<StatefulWorkerRefType, unknown>;

export const DynamicWorkerRef = z.discriminatedUnion("type", [
  StatelessDynamicWorkerRef,
  StatefulDynamicWorkerRef,
]) satisfies z.ZodType<WorkerRefType, unknown>;
