// Implements the "project-config-worker" processor: the bridge that makes the
// project's config worker behave like a stream processor. See contract.ts.

import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import type { StreamEvent } from "@iterate-com/streams/shared/event";
import { ProjectConfigWorkerProcessorContract } from "./contract.ts";

export { ProjectConfigWorkerProcessorContract } from "./contract.ts";

export type ProjectConfigWorkerProcessorDeps = {
  /**
   * Delivers one event to the config worker's `afterAppend` export. The host
   * (ProjectDurableObject) owns the gate (no-op until the config worker has
   * been built) and MUST swallow user-code failures: a throwing afterAppend is
   * the project author's bug and may never wedge the root stream's delivery —
   * the host's poison-batch handling would otherwise disconnect this
   * subscription after repeated failures.
   */
  forwardToConfigWorker(event: StreamEvent): Promise<void>;
};

export class ProjectConfigWorkerProcessor extends StreamProcessor<
  ProjectConfigWorkerProcessorContract,
  ProjectConfigWorkerProcessorDeps
> {
  readonly contract = ProjectConfigWorkerProcessorContract;

  protected override processEvent(
    args: Parameters<StreamProcessor<ProjectConfigWorkerProcessorContract>["processEvent"]>[0],
  ): void {
    // Blocking keeps delivery ordered and checkpointed: the config worker sees
    // events in stream order, exactly once per checkpoint advance (at-least-
    // once across crashes, like every processor side effect).
    args.blockProcessorWhile(() => this.deps.forwardToConfigWorker(args.event));
  }
}
