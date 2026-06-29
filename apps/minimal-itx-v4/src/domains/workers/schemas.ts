import { z } from "zod";
import { normalizePath } from "../durable-object-names.ts";
import type {
  StatefulWorkerRef as StatefulWorkerRefType,
  StatelessWorkerRef as StatelessWorkerRefType,
  WorkerRef as WorkerRefType,
  WorkerSource as WorkerSourceType,
} from "./types.ts";

const DURABLE_WORKER_KEY = /^[a-z][a-z0-9-]{0,62}$/;

const WorkerSource = z.discriminatedUnion("type", [
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
  props: z.record(z.string(), z.json()).optional(),
  source: WorkerSource,
};

export const StatelessWorkerRef = z.strictObject({
  ...WorkerRefBase,
  entrypoint: z.string().optional(),
  type: z.literal("stateless"),
}) satisfies z.ZodType<StatelessWorkerRefType, unknown>;

export const StatefulWorkerRef = z.strictObject({
  ...WorkerRefBase,
  className: z.string(),
  durableWorkerKey: z.string().regex(DURABLE_WORKER_KEY),
  type: z.literal("stateful"),
}) satisfies z.ZodType<StatefulWorkerRefType, unknown>;

export const WorkerRef = z.discriminatedUnion("type", [
  StatelessWorkerRef,
  StatefulWorkerRef,
]) satisfies z.ZodType<WorkerRefType, unknown>;
