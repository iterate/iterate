// Implements the "project-config-worker" processor: the bridge that makes the
// project's config worker behave like a stream processor. See contract.ts.

import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import type { StreamEvent } from "@iterate-com/streams/shared/event";
import { ProjectConfigWorkerProcessorContract } from "./contract.ts";

export { ProjectConfigWorkerProcessorContract } from "./contract.ts";

export type ProjectConfigWorkerProcessorDeps = {
  /**
   * Delivers one event to the config worker's `processEvent` export. The host
   * (ProjectDurableObject) owns the gate (no-op until the config worker has
   * been built) and the failure split: USER-code failures (the project's
   * processEvent throwing) must be swallowed there — the project author's bug
   * may never wedge root-stream delivery into the poison-batch disconnect —
   * while PLATFORM failures (entrypoint resolution, rebuilds) must throw so
   * the blocking delivery below holds the checkpoint and the event is
   * redelivered rather than silently dropped.
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
