import { oc as ocBase } from "@orpc/contract";
import * as v from "valibot";
import { ProcessDefinition } from "../lazy-process.ts";
import { RestartingProcessState } from "../restarting-process.ts";
import { CronProcessState } from "../cron-process.ts";
import { TaskStateSchema } from "../task-list.ts";

const oc = ocBase.$input(v.void());

// Resource target (name or index)
const ResourceTarget = v.union([v.string(), v.number()]);

// Manager state schema
export const ManagerStateSchema = v.picklist([
  "idle",
  "initializing",
  "running",
  "stopping",
  "stopped",
]);

export type ManagerState = v.InferOutput<typeof ManagerStateSchema>;

// Manager status response
export const ManagerStatusSchema = v.object({
  state: ManagerStateSchema,
  processCount: v.number(),
  cronCount: v.number(),
  taskCount: v.number(),
});

export type ManagerStatus = v.InferOutput<typeof ManagerStatusSchema>;

// Process definition schema for API responses (with resolved env vars)
export const ProcessDefinitionInfoSchema = v.object({
  command: v.string(),
  args: v.optional(v.array(v.string())),
  cwd: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
});

export type ProcessDefinitionInfo = v.InferOutput<typeof ProcessDefinitionInfoSchema>;

// API response schemas
export const RestartingProcessInfoSchema = v.object({
  name: v.string(),
  state: RestartingProcessState,
  restarts: v.number(),
  definition: ProcessDefinitionInfoSchema,
  effectiveEnv: v.optional(v.record(v.string(), v.string())),
});

export type RestartingProcessInfo = v.InferOutput<typeof RestartingProcessInfoSchema>;

export const CronProcessInfoSchema = v.object({
  name: v.string(),
  state: CronProcessState,
  runCount: v.number(),
  failCount: v.number(),
  nextRun: v.nullable(v.string()), // ISO date string
  definition: ProcessDefinitionInfoSchema,
  effectiveEnv: v.optional(v.record(v.string(), v.string())),
});

export type CronProcessInfo = v.InferOutput<typeof CronProcessInfoSchema>;

// Named process info for tasks (name + definition)
export const NamedProcessInfoSchema = v.object({
  name: v.string(),
  definition: ProcessDefinitionInfoSchema,
  effectiveEnv: v.optional(v.record(v.string(), v.string())),
});

export type NamedProcessInfo = v.InferOutput<typeof NamedProcessInfoSchema>;

export const TaskEntryInfoSchema = v.object({
  id: v.string(),
  state: TaskStateSchema,
  processNames: v.array(v.string()),
  processes: v.array(NamedProcessInfoSchema),
});

export type TaskEntryInfo = v.InferOutput<typeof TaskEntryInfoSchema>;

// API contract
export const manager = {
  status: oc.output(ManagerStatusSchema),
};

export const processes = {
  get: oc
    .input(v.object({ target: ResourceTarget, includeEffectiveEnv: v.optional(v.boolean()) }))
    .output(RestartingProcessInfoSchema),
  list: oc.output(v.array(RestartingProcessInfoSchema)),
  add: oc
    .input(v.object({ name: v.string(), definition: ProcessDefinition }))
    .output(RestartingProcessInfoSchema),
  start: oc.input(v.object({ target: ResourceTarget })).output(RestartingProcessInfoSchema),
  stop: oc.input(v.object({ target: ResourceTarget })).output(RestartingProcessInfoSchema),
  restart: oc
    .input(v.object({ target: ResourceTarget, force: v.optional(v.boolean()) }))
    .output(RestartingProcessInfoSchema),
  reload: oc
    .input(
      v.object({
        target: ResourceTarget,
        definition: ProcessDefinition,
        restartImmediately: v.optional(v.boolean()),
      }),
    )
    .output(RestartingProcessInfoSchema),
  remove: oc.input(v.object({ target: ResourceTarget })).output(v.object({ success: v.boolean() })),
};

export const tasks = {
  get: oc
    .input(v.object({ target: ResourceTarget, includeEffectiveEnv: v.optional(v.boolean()) }))
    .output(TaskEntryInfoSchema),
  list: oc.output(v.array(TaskEntryInfoSchema)),
  add: oc
    .input(v.object({ name: v.string(), definition: ProcessDefinition }))
    .output(TaskEntryInfoSchema),
  remove: oc.input(v.object({ target: ResourceTarget })).output(TaskEntryInfoSchema),
};

export const crons = {
  get: oc
    .input(v.object({ target: ResourceTarget, includeEffectiveEnv: v.optional(v.boolean()) }))
    .output(CronProcessInfoSchema),
  list: oc.output(v.array(CronProcessInfoSchema)),
  trigger: oc.input(v.object({ target: ResourceTarget })).output(CronProcessInfoSchema),
  start: oc.input(v.object({ target: ResourceTarget })).output(CronProcessInfoSchema),
  stop: oc.input(v.object({ target: ResourceTarget })).output(CronProcessInfoSchema),
};

export const api = {
  manager,
  processes,
  tasks,
  crons,
};
