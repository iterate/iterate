import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { ResolvedWorkerFileSource } from "./build-key.ts";
import { WorkerBuildOptions } from "./schemas.ts";

export const WorkerBuildFailurePhase = z.enum(["resolve-source", "bundle", "store-artifact"]);

const WorkerBuildRequestedPayload = z.strictObject({
  buildKey: z.string().min(1),
  options: WorkerBuildOptions,
  source: ResolvedWorkerFileSource,
});

/** Artifact identity and audit metadata — never built module contents. */
const WorkerBuildCompletedPayload = z.strictObject({
  buildKey: z.string().min(1),
  mainModule: z.string(),
  moduleNames: z.array(z.string()),
  warnings: z.array(z.string()).optional(),
});

const WorkerBuildFailedPayload = z.strictObject({
  buildKey: z.string().min(1),
  message: z.string(),
  phase: WorkerBuildFailurePhase,
});

export const WorkerBuildProcessorContract = defineProcessorContract({
  slug: "worker-build",
  version: "0.1.0",
  description:
    "Materializes dynamic worker sources through Cloudflare's worker bundler into the KV artifact cache, deduped by deterministic build key.",
  stateSchema: z.object({
    // buildKey -> requestedAt (event createdAt). Present while a build is in
    // flight; terminal events delete the entry, so the fold stays small.
    pendingBuilds: z.record(z.string(), z.string()).default({}),
  }),
  events: {
    "events.iterate.com/worker-build/requested": {
      description:
        "A caller needs a loader-ready artifact for this build key and found the artifact cache cold.",
      payloadSchema: WorkerBuildRequestedPayload,
    },
    "events.iterate.com/worker-build/completed": {
      description: "The artifact for this build key is present in the artifact store.",
      payloadSchema: WorkerBuildCompletedPayload,
    },
    "events.iterate.com/worker-build/failed": {
      description: "The build for this key failed; message and phase are sanitized diagnostics.",
      payloadSchema: WorkerBuildFailedPayload,
    },
  },
  consumes: [
    "events.iterate.com/worker-build/requested",
    "events.iterate.com/worker-build/completed",
    "events.iterate.com/worker-build/failed",
  ],
  emits: ["events.iterate.com/worker-build/completed", "events.iterate.com/worker-build/failed"],
});
