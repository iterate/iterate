import { eventIterator, oc as ocBase } from "@orpc/contract";
import * as v from "valibot";
import { ProcessDefinition } from "../lazy-process.ts";
import { RestartingProcessOptions, RestartingProcessState } from "../restarting-process.ts";
import { EnvOptions, ProcessHealthCheck } from "../manager.ts";

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
  inheritProcessEnv: v.optional(v.boolean()),
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

// Wait condition: any process state plus derived "healthy"
export const WaitCondition = v.picklist([
  "idle",
  "running",
  "restarting",
  "stopping",
  "stopped",
  "crash-loop-backoff",
  "max-restarts-reached",
  "healthy",
]);
export type WaitCondition = v.InferOutput<typeof WaitCondition>;

export const WaitForResultEntry = v.object({
  state: RestartingProcessState,
  healthy: v.boolean(),
  elapsedMs: v.number(),
});

export const WaitForResponseSchema = v.object({
  results: v.record(v.string(), WaitForResultEntry),
  allMet: v.boolean(),
});
export type WaitForResponse = v.InferOutput<typeof WaitForResponseSchema>;

export const ProcessLogEntrySchema = v.object({
  text: v.string(),
});
export type ProcessLogEntry = v.InferOutput<typeof ProcessLogEntrySchema>;

// API contract
export const manager = {
  status: oc.output(ManagerStatusSchema),
};

export const HealthCheckConfig = ProcessHealthCheck;
export type HealthCheckConfig = v.InferOutput<typeof HealthCheckConfig>;

export const processes = {
  get: oc
    .input(v.object({ target: ResourceTarget, includeEffectiveEnv: v.optional(v.boolean()) }))
    .output(RestartingProcessInfoSchema),
  list: oc.output(v.array(RestartingProcessInfoSchema)),
  updateConfig: oc
    .input(
      v.object({
        processSlug: v.string(),
        definition: ProcessDefinition,
        options: v.optional(RestartingProcessOptions),
        envOptions: v.optional(EnvOptions),
        tags: v.optional(v.array(v.string())),
        restartImmediately: v.optional(v.boolean()),
        healthCheck: v.optional(HealthCheckConfig),
      }),
    )
    .output(RestartingProcessInfoSchema),
  start: oc.input(v.object({ target: ResourceTarget })).output(RestartingProcessInfoSchema),
  stop: oc.input(v.object({ target: ResourceTarget })).output(RestartingProcessInfoSchema),
  restart: oc
    .input(v.object({ target: ResourceTarget, force: v.optional(v.boolean()) }))
    .output(RestartingProcessInfoSchema),
  delete: oc
    .input(v.object({ processSlug: v.string() }))
    .output(v.object({ success: v.boolean() })),
  waitForRunning: oc
    .input(
      v.object({
        processSlug: v.string(),
        timeoutMs: v.optional(v.number()),
        pollIntervalMs: v.optional(v.number()),
        includeLogs: v.optional(v.boolean()),
        logTailLines: v.optional(v.number()),
      }),
    )
    .output(WaitForRunningResponseSchema),
  waitFor: oc
    .input(
      v.object({
        processes: v.record(v.string(), WaitCondition),
        timeoutMs: v.optional(v.number()),
      }),
    )
    .output(WaitForResponseSchema),
  logs: oc
    .input(
      v.object({
        processSlug: v.string(),
        tailLines: v.optional(v.number()),
        pollIntervalMs: v.optional(v.number()),
      }),
    )
    .output(eventIterator(ProcessLogEntrySchema)),
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
