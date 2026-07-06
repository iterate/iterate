import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";

/**
 * The event catalog, spelled out as a const so
 * {@link SandboxLifecycleEventInput} can be derived from it — the contract
 * object's own `events` key loses the literal payload-schema pairing needed
 * for that mapped type.
 */
const SANDBOX_EVENTS = {
  "events.iterate.com/sandbox/container-started": {
    description:
      "The sandbox container booted (the SDK's onStart hook). Workspace provisioning starts in the background right after this.",
    payloadSchema: z.object({}),
  },
  "events.iterate.com/sandbox/container-stopped": {
    description:
      "The sandbox container exited (the SDK's onStop hook). May be appended on a LATER wake: the SDK delivers a stop that happened while the Durable Object was hibernated on the next wake.",
    payloadSchema: z.object({}),
  },
  "events.iterate.com/sandbox/workspace-restored": {
    description: "/workspace was restored from the named R2 snapshot into the fresh container.",
    payloadSchema: z.object({ backupId: z.string() }),
  },
  "events.iterate.com/sandbox/workspace-cloned": {
    description:
      "/workspace was provisioned by a fresh project-repo clone (no snapshot existed, it expired, or its restore failed).",
    payloadSchema: z.object({}),
  },
  "events.iterate.com/sandbox/workspace-setup-failed": {
    description:
      "Background workspace provisioning failed after its retries; the next ensureProjectRepo() call retries from scratch.",
    payloadSchema: z.object({ error: z.string() }),
  },
  "events.iterate.com/sandbox/backup-created": {
    description:
      "/workspace was snapshotted to R2 as the container idled out (the SDK's onActivityExpired hook); this backup is what the next start restores.",
    payloadSchema: z.object({ backupId: z.string() }),
  },
  "events.iterate.com/sandbox/backup-failed": {
    description:
      "The idle-time workspace snapshot failed; the container still stops, and the previous good backup (if any) remains the restore source.",
    payloadSchema: z.object({ error: z.string() }),
  },
  "events.iterate.com/sandbox/env-configured": {
    description:
      "The sandbox's environment-variable map was configured. Records only the KEYS set — values (getSecret placeholders / non-secret literals) live in Durable Object storage, never on the stream.",
    payloadSchema: z.object({ keys: z.array(z.string()) }),
  },
} as const;

/**
 * The contract for a sandbox's lifecycle events — the public declaration of
 * what `CloudflareSandboxDurableObject` appends to the stream at the sandbox's
 * OWN path (for an agent's sandbox, the agent's journal). The Durable Object
 * is the appender — it builds every event through this contract
 * (`SandboxProcessorContract.buildEvent`), so emission and declaration cannot
 * drift; the processor itself only folds the events into a small status
 * projection and takes no actions (`emits: []`).
 *
 * Event order tells the persistence story: container-started →
 * workspace-restored | workspace-cloned → … → backup-created →
 * container-stopped, then the next start restores the named backup.
 */
export const SandboxProcessorContract = defineProcessorContract({
  slug: "sandbox",
  version: "0.1.0",
  description:
    "Sandbox container lifecycle: starts/stops, workspace restore-or-clone provisioning, and the idle-time R2 workspace snapshots.",
  stateSchema: z.object({
    /** Whether the container is up, as of the latest lifecycle event. */
    running: z.boolean().default(false),
    /** The newest workspace snapshot — what the next container start restores. */
    lastBackupId: z.string().nullable().default(null),
    /** The env-var keys configured on the sandbox (values live in DO storage). */
    envKeys: z.array(z.string()).default([]),
  }),
  events: SANDBOX_EVENTS,
  consumes: [
    "events.iterate.com/sandbox/container-started",
    "events.iterate.com/sandbox/container-stopped",
    "events.iterate.com/sandbox/backup-created",
    "events.iterate.com/sandbox/env-configured",
  ],
  emits: [],
});

/**
 * One lifecycle event as the sandbox Durable Object appends it: the event
 * type paired with ITS OWN payload shape (derived per entry from the catalog,
 * which a plain `{ type, payload }` union over `keyof events` would not give).
 */
export type SandboxLifecycleEventInput = {
  [Type in keyof typeof SANDBOX_EVENTS]: {
    type: Type;
    payload: z.input<(typeof SANDBOX_EVENTS)[Type]["payloadSchema"]>;
  };
}[keyof typeof SANDBOX_EVENTS];
