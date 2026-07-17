import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "../streams/processor-contracts.ts";
import { SandboxInstanceType } from "./instance-types.ts";

const SandboxBirthCertificate = z.object({
  config: z.object({ instanceType: SandboxInstanceType }),
});

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
      "itx.sandboxes.create was called: the claimed path, the requested instance type (fixed for the sandbox's whole life) and any initial config. UNLIKE every other sandbox event this lands on the /sandboxes CATALOGUE stream, idempotency-keyed by path — the append IS the atomic name claim, and its instance type is what routes get(path) to the right container namespace. Setup follows; `created` (on the sandbox's own stream) confirms it.",
    payloadSchema: z.object({
      path: z.string(),
      instanceType: SandboxInstanceType,
      sleepAfter: z.union([z.string(), z.number()]).optional(),
      keepAlive: z.boolean().optional(),
      env: z.record(z.string(), z.string().nullable()).optional(),
    }),
    examples: [
      {
        description:
          'itx.sandboxes.create claims "/sandboxes/main": a basic instance that sleeps after 10 idle minutes, with a getSecret-placeholder env var substituted only at egress.',
        payload: {
          path: "/sandboxes/main",
          instanceType: "basic",
          sleepAfter: "10m",
          env: {
            GH_TOKEN:
              'getSecret({ path: "/secrets/integrations/github/acme", field: "accessToken" })',
          },
        },
      },
    ],
  },
  "events.iterate.com/sandbox/created": {
    description:
      "The sandbox exists: identity and configuration are durably stored and itx.sandboxes.get(path) resolves it. No container is running yet — the first command (or start()) boots one.",
    payloadSchema: SandboxBirthCertificate,
    examples: [
      {
        description: "A basic sandbox finished setup and is ready to boot on the first command.",
        payload: { config: { instanceType: "basic" } },
      },
    ],
  },
  "events.iterate.com/sandbox/start-requested": {
    description:
      "start() was called: boot the container now (rather than lazily on the first command). `started` confirms the boot.",
    payloadSchema: z.object({}),
    examples: [
      {
        description: "start() was called to boot the container ahead of the first command.",
        payload: {},
      },
    ],
  },
  "events.iterate.com/sandbox/started": {
    description:
      "The sandbox container booted (the SDK's onStart hook) — after an explicit start() OR implicitly because a command reached a stopped sandbox. /workspace is restored from the newest snapshot before commands run.",
    payloadSchema: z.object({}),
    examples: [
      {
        description: "A command reached a stopped sandbox, so a fresh container booted implicitly.",
        payload: {},
      },
    ],
  },
  "events.iterate.com/sandbox/sleep-requested": {
    description:
      "sleep() was called (Cloudflare's word for what the idle timer does, on demand): snapshot /workspace, then tear the container down. The sandbox stays created — the next start (or command) boots a fresh container and restores the snapshot. The SDK's stop() forwards here so no spelling skips the snapshot.",
    payloadSchema: z.object({}),
    examples: [
      {
        description:
          "sleep() was called: snapshot /workspace, then tear the container down until the next command.",
        payload: {},
      },
    ],
  },
  "events.iterate.com/sandbox/stopped": {
    description:
      "The sandbox container exited (the SDK's onStop hook) — after an explicit sleep(), the idle timer (sleepAfter), or a destroy. May be appended on a LATER wake: the SDK delivers a stop that happened while the Durable Object was hibernated on the next wake.",
    payloadSchema: z.object({}),
    examples: [
      {
        description: "The idle timer expired and the container exited.",
        payload: {},
      },
    ],
  },
  "events.iterate.com/sandbox/kill-requested": {
    description:
      "kill() was called: the current Durable Object incarnation is deliberately aborted after this fact is durably folded. The container lifecycle and reduced running state are unchanged; the next request boots a fresh object around the same sandbox.",
    payloadSchema: z.object({}),
    examples: [
      {
        description:
          "An operator requested a Durable Object restart while leaving the running container alone.",
        payload: {},
      },
    ],
  },
  "events.iterate.com/sandbox/destroy-requested": {
    description: "destroy() was called: tear the sandbox down permanently. `destroyed` confirms.",
    payloadSchema: z.object({}),
    examples: [
      {
        description: "destroy() was called: tear the sandbox down permanently.",
        payload: {},
      },
    ],
  },
  "events.iterate.com/sandbox/destroyed": {
    description:
      "The sandbox is permanently gone: container torn down and the identity tombstoned — the path can never be created again (pick a new name). Workspace snapshots in R2 age out on their ttl.",
    payloadSchema: z.object({}),
    examples: [
      {
        description:
          "The teardown landed: the container is gone and the path is tombstoned forever.",
        payload: {},
      },
    ],
  },
  "events.iterate.com/sandbox/workspace-restored": {
    description:
      "/workspace was restored from the named R2 snapshot into the fresh container — what makes stop/sleep survivable: files under /workspace come back, everything else on the container disk is gone.",
    payloadSchema: z.object({ backupId: z.string() }),
    examples: [
      {
        description:
          "A fresh container restored /workspace from the newest snapshot (backup ids are the SDK's random UUIDs).",
        payload: { backupId: "3f2c9a4e-8b1d-4e7a-9c6f-2d5b8a1e4f7c" },
      },
    ],
  },
  "events.iterate.com/sandbox/backup-created": {
    description:
      "/workspace was snapshotted to R2 (an explicit sleep() or the idle timer); this backup is what the next start restores.",
    payloadSchema: z.object({ backupId: z.string() }),
    examples: [
      {
        description: "The idle timer snapshotted /workspace to R2 before stopping the container.",
        payload: { backupId: "3f2c9a4e-8b1d-4e7a-9c6f-2d5b8a1e4f7c" },
      },
    ],
  },
  "events.iterate.com/sandbox/backup-failed": {
    description:
      "A workspace snapshot failed; the container still stops, and the previous good backup (if any) remains the restore source.",
    payloadSchema: z.object({ error: z.string() }),
    examples: [
      {
        description:
          "The snapshot could not be archived; the previous good backup remains the restore source.",
        payload: { error: "createBackup failed: container exited before the archive completed" },
      },
    ],
  },
  "events.iterate.com/sandbox/configured": {
    description:
      "The sandbox's env-var map changed (setEnvVars, or `env` at create). `env` is the map set in this change (key → value; null = key unset); values are conventionally `getSecret({ path })` placeholders substituted only at egress, or non-secret literals. NEVER put raw secret material in a value — it lands on this durable stream.",
    payloadSchema: z.object({ env: z.record(z.string(), z.string().nullable()) }),
    examples: [
      {
        description:
          "setEnvVars set GH_TOKEN to a getSecret placeholder (substituted only at egress) and unset DEBUG.",
        payload: {
          env: {
            GH_TOKEN:
              'getSecret({ path: "/secrets/integrations/github/acme", field: "accessToken" })',
            DEBUG: null,
          },
        },
      },
    ],
  },
} as const;

/** Where a sandbox is in its life, as of the latest lifecycle event. */
const SandboxStatus = z.enum(["created", "running", "stopped", "destroyed"]);

/**
 * The contract for the sandbox lifecycle events. Two appenders, both building
 * through this contract (`SandboxProcessorContract.buildEvent`) so emission
 * and declaration cannot drift: the collection appends `create-requested` to
 * the `/sandboxes` CATALOGUE stream (journal-first — the idempotency-keyed
 * append both claims the name atomically and records the instance type that
 * routes every later `get` to the right container namespace), and the sandbox
 * Durable Object appends everything else to the stream at the sandbox's OWN
 * path. The processor itself only folds the events into a small status
 * projection and takes no actions (`emits: []`).
 *
 * A typical pet's own stream reads: created → started → … work … →
 * sleep-requested → backup-created → stopped → started (next day, implicit
 * wake) → workspace-restored → kill-requested → … →
 * destroy-requested → stopped → destroyed —
 * while the catalogue accumulates one create-requested per name ever claimed.
 */
export const SandboxProcessorContract = defineProcessorContract({
  slug: "sandbox",
  version: "0.4.0",
  description:
    "Sandbox lifecycle: explicit create/start/sleep/destroy commands and their completions, workspace snapshot/restore persistence, and configuration changes.",
  stateSchema: z.object({
    birthCertificate: SandboxBirthCertificate.nullable().default(null),
    /** Null until the birth certificate is reduced. */
    status: SandboxStatus.nullable().default(null),
    /** The simple operational projection consumed by lists and controls. */
    running: z.boolean().default(false),
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

/** The sandbox processor's reduced lifecycle projection. */
export type SandboxProcessorState = ProcessorState<typeof SandboxProcessorContract>;

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
