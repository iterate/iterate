import { z } from "zod";
import { defineProcessorContract } from "../streams/processor-contracts.ts";
import { SandboxInstanceType } from "./instance-types.ts";

/**
 * The event catalog, spelled out as a const so
 * {@link SandboxLifecycleEventInput} can be derived from it — the contract
 * object's own `events` key loses the literal payload-schema pairing needed
 * for that mapped type.
 *
 * The vocabulary is imperative-command pairs: every lifecycle verb appears as
 * `<verb>-requested` (the command was issued — intent, recorded before
 * anything happens) and a past-tense completion (`created`, `started`,
 * `stopped`, `destroyed` — reality, recorded when the transition actually
 * lands). The two can be far apart (a container boot takes tens of seconds),
 * and a completion can arrive WITHOUT a request: the container also starts
 * implicitly when a command reaches a stopped sandbox, and stops on its own
 * when the idle timer expires — so `started`/`stopped` are the authoritative
 * signal and the `-requested` events are the record of who asked.
 */
const SANDBOX_EVENTS = {
  "events.iterate.com/sandbox/create-requested": {
    description:
      "itx.sandboxes.create was called for this path: the requested instance type (fixed for the sandbox's whole life) and any initial config. Setup follows; `created` confirms it.",
    payloadSchema: z.object({
      instanceType: SandboxInstanceType,
      sleepAfter: z.union([z.string(), z.number()]).optional(),
      keepAlive: z.boolean().optional(),
      env: z.record(z.string(), z.string().nullable()).optional(),
    }),
  },
  "events.iterate.com/sandbox/created": {
    description:
      "The sandbox exists: identity and configuration are durably stored and itx.sandboxes.get(path) resolves it. No container is running yet — the first command (or start()) boots one.",
    payloadSchema: z.object({ instanceType: SandboxInstanceType }),
  },
  "events.iterate.com/sandbox/start-requested": {
    description:
      "start() was called: boot the container now (rather than lazily on the first command). `started` confirms the boot.",
    payloadSchema: z.object({}),
  },
  "events.iterate.com/sandbox/started": {
    description:
      "The sandbox container booted (the SDK's onStart hook) — after an explicit start() OR implicitly because a command reached a stopped sandbox. /workspace is restored from the newest snapshot before commands run.",
    payloadSchema: z.object({}),
  },
  "events.iterate.com/sandbox/sleep-requested": {
    description:
      "sleep() was called (Cloudflare's word for what the idle timer does, on demand): snapshot /workspace, then tear the container down. The sandbox stays created — the next start (or command) boots a fresh container and restores the snapshot. The SDK's stop() forwards here so no spelling skips the snapshot.",
    payloadSchema: z.object({}),
  },
  "events.iterate.com/sandbox/stopped": {
    description:
      "The sandbox container exited (the SDK's onStop hook) — after an explicit sleep(), the idle timer (sleepAfter), or a destroy. May be appended on a LATER wake: the SDK delivers a stop that happened while the Durable Object was hibernated on the next wake.",
    payloadSchema: z.object({}),
  },
  "events.iterate.com/sandbox/destroy-requested": {
    description: "destroy() was called: tear the sandbox down permanently. `destroyed` confirms.",
    payloadSchema: z.object({}),
  },
  "events.iterate.com/sandbox/destroyed": {
    description:
      "The sandbox is permanently gone: container torn down and the identity tombstoned — the path can never be created again (pick a new name). Workspace snapshots in R2 age out on their ttl.",
    payloadSchema: z.object({}),
  },
  "events.iterate.com/sandbox/workspace-restored": {
    description:
      "/workspace was restored from the named R2 snapshot into the fresh container — what makes stop/sleep survivable: files under /workspace come back, everything else on the container disk is gone.",
    payloadSchema: z.object({ backupId: z.string() }),
  },
  "events.iterate.com/sandbox/backup-created": {
    description:
      "/workspace was snapshotted to R2 (an explicit sleep() or the idle timer); this backup is what the next start restores.",
    payloadSchema: z.object({ backupId: z.string() }),
  },
  "events.iterate.com/sandbox/backup-failed": {
    description:
      "A workspace snapshot failed; the container still stops, and the previous good backup (if any) remains the restore source.",
    payloadSchema: z.object({ error: z.string() }),
  },
  "events.iterate.com/sandbox/configured": {
    description:
      "The sandbox's env-var map changed (setEnvVars, or `env` at create). `env` is the map set in this change (key → value; null = key unset); values are conventionally `getSecret({ path })` placeholders substituted only at egress, or non-secret literals. NEVER put raw secret material in a value — it lands on this durable stream.",
    payloadSchema: z.object({ env: z.record(z.string(), z.string().nullable()) }),
  },
} as const;

/** Where a sandbox is in its life, as of the latest lifecycle event. */
const SandboxStatus = z.enum(["created", "running", "stopped", "destroyed"]);

/**
 * The contract for a sandbox's lifecycle events — the public declaration of
 * what the sandbox Durable Object appends to the stream at the sandbox's OWN
 * path. The Durable Object is the appender — it builds every event through
 * this contract (`SandboxProcessorContract.buildEvent`), so emission and
 * declaration cannot drift; the processor itself only folds the events into a
 * small status projection and takes no actions (`emits: []`).
 *
 * A typical pet's stream reads: create-requested → created → started →
 * … work … → sleep-requested → backup-created → stopped → started (next day,
 * implicit wake) → workspace-restored → … → destroy-requested → stopped →
 * destroyed.
 */
export const SandboxProcessorContract = defineProcessorContract({
  slug: "sandbox",
  version: "0.2.0",
  description:
    "Sandbox lifecycle: explicit create/start/sleep/destroy commands and their completions, workspace snapshot/restore persistence, and configuration changes.",
  stateSchema: z.object({
    /** Where the sandbox is in its life. Default "created": state only exists
     * once events do, and the first event is the create. */
    status: SandboxStatus.default("created"),
    /** The sandbox's Cloudflare instance type — fixed at create. */
    instanceType: SandboxInstanceType.nullable().default(null),
    /** The newest workspace snapshot — what the next container start restores. */
    lastBackupId: z.string().nullable().default(null),
    /** The sandbox's configured env-var map (key → getSecret placeholder /
     * literal), merged across all `configured` events; null unsets. */
    env: z.record(z.string(), z.string()).default({}),
  }),
  events: SANDBOX_EVENTS,
  consumes: [
    "events.iterate.com/sandbox/created",
    "events.iterate.com/sandbox/started",
    "events.iterate.com/sandbox/stopped",
    "events.iterate.com/sandbox/destroyed",
    "events.iterate.com/sandbox/backup-created",
    "events.iterate.com/sandbox/configured",
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
