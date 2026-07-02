import { z } from "zod";
import { defineProcessorContract } from "../streams/stream-processor.ts";
import { WorkerBuildOptions } from "./schemas.ts";

/**
 * Resolved file source as recorded in build lifecycle events.
 *
 * Repo sources carry identity (repo path, pinned commit, masks) and never
 * expanded file contents — the processor re-resolves them from the repo.
 * Inline sources carry the caller-provided file map by design: for
 * worker-backed provided capabilities the event log IS the durable home of
 * that small file map.
 */
const ResolvedWorkerFileSourcePayload = z.discriminatedUnion("type", [
  z.strictObject({
    files: z.record(z.string(), z.string()),
    type: z.literal("inline"),
  }),
  z.strictObject({
    commitOid: z.string().regex(/^[0-9a-f]{40}$/),
    contentHash: z.string().optional(),
    exclude: z.array(z.string()).optional(),
    include: z.array(z.string()).optional(),
    repoPath: z.string(),
    type: z.literal("repo"),
  }),
]);

export const WorkerBuildFailurePhase = z.enum(["resolve-source", "bundle", "store-artifact"]);

const WorkerBuildRequestedPayload = z.strictObject({
  buildKey: z.string().min(1),
  compatibilityDate: z.string(),
  compatibilityFlags: z.array(z.string()),
  options: WorkerBuildOptions,
  source: ResolvedWorkerFileSourcePayload,
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
