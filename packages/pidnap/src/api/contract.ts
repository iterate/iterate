import { oc as ocBase } from "@orpc/contract";
import * as v from "valibot";
import { ProcessDefinition } from "../lazy-process.ts";
import { RestartingProcessOptions, RestartingProcessState } from "../restarting-process.ts";
import { EnvOptions } from "../manager.ts";

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
  tags: v.array(v.string()),
  state: RestartingProcessState,
  restarts: v.number(),
  definition: ProcessDefinitionInfoSchema,
  effectiveEnv: v.optional(v.record(v.string(), v.string())),
});

export type RestartingProcessInfo = v.InferOutput<typeof RestartingProcessInfoSchema>;

// Wait for running response - includes logs
export const WaitForRunningResponseSchema = v.object({
  name: v.string(),
  state: RestartingProcessState,
  restarts: v.number(),
  elapsedMs: v.number(),
  logs: v.optional(v.string()),
});

export type WaitForRunningResponse = v.InferOutput<typeof WaitForRunningResponseSchema>;

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
    .input(
      v.object({
        name: v.string(),
        definition: ProcessDefinition,
        options: v.optional(RestartingProcessOptions),
        envOptions: v.optional(EnvOptions),
        tags: v.optional(v.array(v.string())),
      }),
    )
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
        tags: v.optional(v.array(v.string())),
      }),
    )
    .output(RestartingProcessInfoSchema),
  remove: oc.input(v.object({ target: ResourceTarget })).output(v.object({ success: v.boolean() })),
  waitForRunning: oc
    .input(
      v.object({
        target: ResourceTarget,
        timeoutMs: v.optional(v.number()), // default 60000
        pollIntervalMs: v.optional(v.number()), // default 500
        includeLogs: v.optional(v.boolean()), // default true
        logTailLines: v.optional(v.number()), // default 100
      }),
    )
    .output(WaitForRunningResponseSchema),
};

// Simple health check response
export const HealthResponseSchema = v.object({
  status: v.literal("ok"),
});

export type HealthResponse = v.InferOutput<typeof HealthResponseSchema>;

export const health = oc.output(HealthResponseSchema);

export const api = {
  health,
  manager,
  processes,
};
