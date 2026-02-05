import { oc as ocBase } from "@orpc/contract";
import * as v from "valibot";
import { ProcessDefinition } from "../lazy-process.ts";
import { RestartingProcessState } from "../restarting-process.ts";

const oc = ocBase.$input(v.void());

// Resource target (name or index)
const ResourceTarget = v.union([v.string(), v.number()]);

// Manager state schema
export const ManagerStateSchema = v.picklist(["idle", "running", "stopping", "stopped"]);

export type ManagerState = v.InferOutput<typeof ManagerStateSchema>;

// Manager status response
export const ManagerStatusSchema = v.object({
  state: ManagerStateSchema,
  processCount: v.number(),
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

export const api = {
  manager,
  processes,
};
