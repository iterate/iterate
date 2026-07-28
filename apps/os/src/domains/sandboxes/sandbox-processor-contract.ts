// The sandbox lifecycle CONTRACT. Self-contained: state schema, events,
// consumes/emits — every payload schema spelled inline in the contract; the
// ONE schema it uses twice (the birth certificate, carried by the
// `sandbox/created` payload and by the reduced state) is a hoisted function
// below the contract, so the contract still opens the file.

import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/processors";
import { SandboxInstanceType } from "./instance-types.ts";

/**
 * The contract for the sandbox lifecycle events. Two appenders, both building
 * through this contract (`SandboxProcessorContract.buildEvent`) so emission
 * and declaration cannot drift: the collection appends `create-requested` to
 * the `/sandboxes` CATALOGUE stream (the idempotency-keyed append both claims
 * the name atomically and records the instance type that routes every later
 * `get` to the right container namespace), and the sandbox Durable Object
 * appends everything else to the stream at the sandbox's OWN path. The
 * processor itself only reduces the events into a small status projection and
 * takes no actions (`emits: []`).
 *
 * The vocabulary is imperative-command pairs: every lifecycle verb appears as
 * `<verb>-requested` (the command was issued — intent, recorded before
 * anything happens) and a past-tense completion (`created`, `started`,
 * `stopped`, `destroyed` — reality, recorded when the transition actually
 * lands). The two can be far apart (a container boot takes tens of seconds),
 * and a completion can arrive WITHOUT a request: the container also starts
 * implicitly when a command reaches a stopped sandbox, and stops on its own
 * when the idle timer expires — so `started`/`stopped` are the authoritative
 * signal and the `-requested` events are the record of who asked. Only the
 * completions (plus `backup-created` and `configured`) are consumed; the
 * remaining commands and snapshot reports are unconsumed audit facts.
 *
 * A typical pet's own stream reads: created → started → … work … →
 * sleep-requested → backup-created → stopped → started (next day, implicit
 * wake) → workspace-restored → kill-requested → … →
 * destroy-requested → stopped → destroyed —
 * while the catalogue accumulates one create-requested per name ever claimed.
 */
export const SandboxProcessorContract = defineProcessorContract({
  slug: "sandbox",
  // Force a reduce-only replay after the production stream namespace was
  // recreated while hosted sandbox checkpoints survived. This repairs the
  // terminal state from the durable stream without rerunning effects (this
  // processor has none).
  version: "0.4.1",
  description:
    "Sandbox lifecycle: explicit create/start/sleep/destroy commands and their completions, workspace snapshot/restore persistence, and configuration changes.",
  stateSchema: z.object({
    birthCertificate: sandboxBirthCertificateSchema().nullable().default(null).meta({
      description:
        "Existence marker: null until sandbox/created reduces. Carries the configuration fixed at birth (the instance type).",
    }),
    status: z.enum(["created", "running", "stopped", "destroyed"]).nullable().default(null).meta({
      description:
        "Where the sandbox is in its life, as of the newest lifecycle completion; null until the birth certificate is reduced. `destroyed` is terminal.",
    }),
    running: z.boolean().default(false).meta({
      description:
        "Whether a container is up right now — the simple operational projection consumed by lists and live controls.",
    }),
    lastBackupId: z.string().nullable().default(null).meta({
      description:
        "The newest /workspace snapshot — what the next container start restores; null before the first snapshot.",
    }),
    env: z.record(z.string(), z.string()).default({}).meta({
      description:
        "The sandbox's configured env-var map (key → getSecret placeholder / literal), merged across all `configured` events; a null value in a `configured` event unsets its key.",
    }),
  }),
  events: {
    "events.iterate.com/sandbox/create-requested": {
      description:
        "itx.sandboxes.get(path).create was called: the claimed path, the requested instance type (fixed for the sandbox's whole life) and any initial config. UNLIKE every other sandbox event this lands on the /sandboxes CATALOGUE stream, idempotency-keyed by path — the append IS the atomic name claim, and its instance type is what routes get(path) to the right container namespace. Setup follows; `created` (on the sandbox's own stream) confirms it.",
      payloadSchema: z.object({
        path: z.string().meta({
          description:
            "The claimed sandbox path (/sandboxes/<name>) — the idempotency-keyed catalogue append is the atomic claim on this name.",
        }),
        instanceType: SandboxInstanceType.meta({
          description:
            "Cloudflare container instance type, fixed for the sandbox's whole life; routes every later get(path) to the right container namespace.",
        }),
        sleepAfter: z.union([z.string(), z.number()]).optional().meta({
          description:
            'Idle window before the automatic snapshot-and-teardown: a positive number of seconds or "<n>s"/"<n>m"/"<n>h" (the SDK\'s own format).',
        }),
        keepAlive: z.boolean().optional().meta({
          description: "When true, the idle timer never tears the container down.",
        }),
        env: z.record(z.string(), z.string().nullable()).optional().meta({
          description:
            "Initial env-var map, applied as if by setEnvVars (key → getSecret placeholder or non-secret literal; null unsets). Never raw secret material — this lands on a durable stream.",
        }),
      }),
    },
    "events.iterate.com/sandbox/created": {
      description:
        "The sandbox exists: identity and configuration are durably stored and itx.sandboxes.get(path) resolves it. No container is running yet — the first command (or start()) boots one.",
      payloadSchema: sandboxBirthCertificateSchema(),
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
    "events.iterate.com/sandbox/kill-requested": {
      description:
        "kill() was called: the current Durable Object incarnation is deliberately aborted after this fact is durably reduced. The container lifecycle and reduced running state are unchanged; the next request boots a fresh object around the same sandbox.",
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
      payloadSchema: z.object({
        backupId: z.string().meta({
          description: "The restored R2 snapshot's id (the SDK's random UUID).",
        }),
      }),
    },
    "events.iterate.com/sandbox/backup-created": {
      description:
        "/workspace was snapshotted to R2 (an explicit sleep() or the idle timer); this backup is what the next start restores.",
      payloadSchema: z.object({
        backupId: z.string().meta({
          description:
            "The new R2 snapshot's id (the SDK's random UUID) — the next restore source.",
        }),
      }),
    },
    "events.iterate.com/sandbox/backup-failed": {
      description:
        "A workspace snapshot failed; the container still stops, and the previous good backup (if any) remains the restore source.",
      payloadSchema: z.object({
        error: z.string().meta({ description: "What the snapshot attempt reported." }),
      }),
    },
    "events.iterate.com/sandbox/configured": {
      description:
        "The sandbox's env-var map changed (setEnvVars, or `env` at create). `env` is the map set in this change (key → value; null = key unset); values are conventionally `getSecret(path)` placeholders substituted only at egress, or non-secret literals. NEVER put raw secret material in a value — it lands on this durable stream.",
      payloadSchema: z.object({
        env: z.record(z.string(), z.string().nullable()).meta({
          description:
            "The entries set in THIS change (key → getSecret placeholder / literal; null unsets the key) — not the full resulting map.",
        }),
      }),
    },
  },
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
export type SandboxProcessorContract = typeof SandboxProcessorContract;

/** The sandbox processor's reduced lifecycle projection. */
export type SandboxProcessorState = ProcessorState<SandboxProcessorContract>;

/**
 * One lifecycle event as the sandbox Durable Object appends it: the event
 * type paired with ITS OWN payload shape, derived per entry from the
 * contract's event catalog (which a plain `{ type, payload }` union over
 * `keyof events` would not give).
 */
export type SandboxLifecycleEventInput = {
  [Type in keyof SandboxProcessorContract["events"]]: {
    type: Type;
    payload: z.input<SandboxProcessorContract["events"][Type]["payloadSchema"]>;
  };
}[keyof SandboxProcessorContract["events"]];

/**
 * The birth certificate — the ONE schema the contract uses twice (the
 * `sandbox/created` payload and the reduced state's `birthCertificate`
 * slot): the configuration fixed at birth. A hoisted function declaration so
 * the contract can open the file.
 */
function sandboxBirthCertificateSchema() {
  return z.object({
    config: z
      .object({
        instanceType: SandboxInstanceType.meta({
          description:
            "Cloudflare container instance type — fixed for the sandbox's whole life (it selects the container class, and Cloudflare fixes instance type per class).",
        }),
      })
      .meta({ description: "The configuration fixed at birth." }),
  });
}
