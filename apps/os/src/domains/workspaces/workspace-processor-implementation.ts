import { StreamProcessor } from "iterate/processors";
import { foldWorkspaceConfig, WorkspaceProcessorContract } from "./workspace-processor-contract.ts";

/**
 * The workspace lifecycle processor: a pure fold of the birth certificate and
 * configuration patches into `{ birthCertificate, config }`. Deliberately no
 * `processEvent` — the workspace Durable Object is the imperative actor (it
 * appends these events and serves the filesystem); this class exists so the
 * mount table is event-sourced state with the platform's ordinary
 * created/configured semantics.
 */
export class WorkspaceProcessor extends StreamProcessor<WorkspaceProcessorContract> {
  readonly contract = WorkspaceProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<WorkspaceProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/workspace/created":
        // FIRST certificate wins. A second created event (a raw append under
        // a different idempotency key is schema-valid) is skipped, never
        // thrown on — a committed fact must not wedge the fold.
        if (state.birthCertificate !== null) return state;
        return {
          ...state,
          birthCertificate: event.payload,
          config: event.payload.config,
        };
      case "events.iterate.com/workspace/configured":
        return {
          ...state,
          config: foldWorkspaceConfig(state.config, event.payload.config),
        };
      default:
        return state;
    }
  }
}
