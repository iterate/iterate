import { StreamProcessor } from "iterate/stream-processor";
import { SandboxProcessorContract } from "./sandbox-processor-contract.ts";

/**
 * The sandbox lifecycle processor: folds the events declared by
 * {@link SandboxProcessorContract} into a small status projection (where the
 * sandbox is in its life, which snapshot a restart would restore).
 * Deliberately takes NO actions — the lifecycle itself is driven by the
 * imperative commands and SDK hooks inside the sandbox Durable Object, which
 * appends these events; this class exists to hold the contract and give
 * stream consumers a folded view. Not yet wired to a processor host anywhere.
 */
export class SandboxProcessor extends StreamProcessor<typeof SandboxProcessorContract> {
  readonly contract = SandboxProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof SandboxProcessorContract>["reduce"]>[0]) {
    // `destroyed` is terminal: a late-delivered `stopped` (the SDK can deliver
    // a stop on a wake AFTER the destroy) must not resurrect the status.
    const terminal = state.status === "destroyed";
    switch (event.type) {
      case "events.iterate.com/sandbox/created":
        if (state.birthCertificate !== null) {
          throw new Error("Sandbox processor received more than one sandbox/created event");
        }
        return {
          ...state,
          birthCertificate: event.payload,
          status: "created" as const,
        };
      case "events.iterate.com/sandbox/started":
        return terminal ? state : { ...state, status: "running" as const };
      case "events.iterate.com/sandbox/stopped":
        return terminal ? state : { ...state, status: "stopped" as const };
      case "events.iterate.com/sandbox/destroyed":
        return { ...state, status: "destroyed" as const };
      case "events.iterate.com/sandbox/backup-created":
        return { ...state, lastBackupId: event.payload.backupId };
      case "events.iterate.com/sandbox/configured": {
        // Later configs win per key; a null value unsets the key (the SDK's
        // own setEnvVars semantics — undefined unsets, journaled as null).
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
