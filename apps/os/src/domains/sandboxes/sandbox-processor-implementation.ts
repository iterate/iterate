import { StreamProcessor } from "iterate/processors";
import type { ReduceArgs } from "iterate/processors";
import { SandboxProcessorContract } from "./sandbox-processor-contract.ts";

/**
 * The sandbox lifecycle processor — a PURE reducer.
 *
 * HOW IT WORKS, end to end: sandboxes are pets. `itx.sandboxes.get(path).create`
 * appends the name-claiming `sandbox/create-requested` to the `/sandboxes`
 * catalogue stream, and from then on the sandbox Durable Object
 * (cloudflare/cloudflare-sandbox-durable-object.ts) appends every command and
 * completion — `created`, `start-requested`, `started`, `sleep-requested`,
 * `backup-created`, `stopped`, `workspace-restored`, `backup-failed`,
 * `kill-requested`, `configured`, `destroy-requested`, `destroyed` — to the
 * stream at the sandbox's OWN path. This processor reduces those events into
 * the small projection that lists and live controls read: where the sandbox
 * is in its life (`status`), whether a container is up right now (`running`),
 * which snapshot the next boot restores (`lastBackupId`), and the configured
 * env-var map (`env`).
 *
 * Deliberately NO `processEvent` and `emits: []`: the lifecycle itself is
 * driven by the imperative commands and SDK hooks inside the Durable Object,
 * which appends the facts and awaits this reduction wherever a command
 * boundary needs coherent state. Because nothing here ever owes background
 * work, the Durable Object hosts the processor with recovery disabled (no
 * keepalive alarm — the container SDK owns that object's one alarm).
 *
 * The one reduce subtlety is ordering under hibernation: the SDK delivers a
 * container stop that happened while the Durable Object slept on the NEXT
 * wake, so a late `stopped` can land after `destroyed`. `destroyed` is
 * terminal — reduce refuses to resurrect the status.
 */
export class SandboxProcessor extends StreamProcessor<SandboxProcessorContract> {
  readonly contract = SandboxProcessorContract;

  // ------------------------------------------------------------------ reduce
  // Pure, one switch, cases inline. Only the completions (plus backup-created
  // and configured) are consumed; the `-requested` commands and snapshot
  // reports are audit facts that never reach this switch.
  protected override reduce({ event, state }: ReduceArgs<SandboxProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/sandbox/created":
        // A duplicate committed certificate is harmless here. Conflicting
        // create payloads are rejected at the stream's idempotency boundary.
        if (state.birthCertificate !== null) return state;
        return {
          ...state,
          birthCertificate: event.payload,
          running: false,
          status: "created" as const,
        };
      case "events.iterate.com/sandbox/started":
        // `destroyed` is terminal: a late-delivered lifecycle hook (the SDK
        // can deliver a stop — or a stale start — on a wake AFTER the
        // destroy) must not resurrect the status.
        if (state.status === "destroyed") return state;
        return { ...state, running: true, status: "running" as const };
      case "events.iterate.com/sandbox/stopped":
        if (state.status === "destroyed") return state;
        return { ...state, running: false, status: "stopped" as const };
      case "events.iterate.com/sandbox/destroyed":
        return { ...state, running: false, status: "destroyed" as const };
      case "events.iterate.com/sandbox/backup-created":
        return { ...state, lastBackupId: event.payload.backupId };
      case "events.iterate.com/sandbox/configured": {
        // Later configs win per key; a null value unsets the key (the SDK's
        // own setEnvVars semantics — undefined unsets, recorded as null
        // because undefined does not survive JSON).
        const env = { ...state.env };
        for (const [key, value] of Object.entries(event.payload.env)) {
          if (value === null) delete env[key];
          else env[key] = value;
        }
        return { ...state, env };
      }
      default:
        return state;
    }
  }
}
