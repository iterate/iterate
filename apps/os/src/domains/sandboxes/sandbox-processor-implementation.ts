import { StreamProcessor } from "../streams/stream-processor.ts";
import { SandboxProcessorContract } from "./sandbox-processor-contract.ts";

/**
 * The sandbox lifecycle processor: folds the events declared by
 * {@link SandboxProcessorContract} into a small status projection (is the
 * container running, which snapshot would a restart restore). Deliberately
 * takes NO actions — the lifecycle itself is driven by the Sandbox SDK's hooks
 * inside `CloudflareSandboxDurableObject`, which appends these events; this
 * class exists to hold the contract and give stream consumers a folded view.
 * Not yet wired to a processor host anywhere.
 */
export class SandboxProcessor extends StreamProcessor<typeof SandboxProcessorContract> {
  readonly contract = SandboxProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof SandboxProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/sandbox/container-started":
        return { ...state, running: true };
      case "events.iterate.com/sandbox/container-stopped":
        return { ...state, running: false };
      case "events.iterate.com/sandbox/backup-created":
        return { ...state, lastBackupId: event.payload.backupId };
      case "events.iterate.com/sandbox/configured":
        // Merge the newly-configured env map over the known one (config merges).
        return { ...state, env: { ...state.env, ...event.payload.env } };
      default:
        return state;
    }
  }
}
