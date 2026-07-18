import { DurableObjectNameCodec, normalizePath } from "../durable-object-names.ts";

/** The default project Scheduler stream; `itx.scheduler` is this path's handle. */
export const SCHEDULER_PRIMARY_PATH = "/scheduler/primary";

/**
 * Scheduler RPC and the Scheduler Durable Object both use stream paths as
 * durable identity. This guard keeps the `/scheduler/...` contract at the edge
 * where callers choose a path, mirroring `parseAgentPath`.
 */
export function normalizeSchedulerPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("/scheduler/")) {
    throw new Error(`scheduler path must start with "/scheduler/", got "${normalized}"`);
  }
  return normalized;
}

export function parseSchedulerDurableObjectName(name: string) {
  const parsed = DurableObjectNameCodec.parse(name);
  normalizeSchedulerPath(parsed.path);
  return parsed;
}
