import { describe, expect, it } from "vitest";
import { isProjectWorkerUnavailableDelivery } from "./stream-durable-object.ts";

// The classification decides which delivery lane a project-worker rejection
// takes: receiver-unavailability parks and retries (backoff → loud halt,
// nothing lost), while an unrecognized error under `onFailingEvent: "skip"`
// enters the failing-EVENT lane — isolate, confirm, skip — which during a
// project's first ~minute of worker build would skip healthy events
// (agent births included) and then trip the mass-skip halt. Every signal
// here is name-based because these errors cross Workers RPC.

describe("isProjectWorkerUnavailableDelivery", () => {
  it("classifies a build-in-progress rejection as receiver unavailability", () => {
    const error = new Error("worker source build has not completed");
    error.name = "WorkerBuildInProgressError";
    expect(isProjectWorkerUnavailableDelivery(error)).toBe(true);
  });

  it("classifies a not-yet-seeded config repo as receiver unavailability", () => {
    const error = new Error("repo has no commits yet");
    error.name = "RepoNotSeededError";
    expect(isProjectWorkerUnavailableDelivery(error)).toBe(true);
  });

  it("classifies a deterministic build failure as receiver unavailability (down until a fix commit)", () => {
    const error = new Error("Expected ; but found is");
    error.name = "WorkerBuildFailedError";
    expect(isProjectWorkerUnavailableDelivery(error)).toBe(true);
  });

  it("classifies the workerd hung-entrypoint cancellation as receiver unavailability", () => {
    const error = new Error(
      "The Workers runtime canceled this request because it detected that your Worker's code had hung and would never generate a response.",
    );
    expect(isProjectWorkerUnavailableDelivery(error)).toBe(true);
  });

  it("finds the signal anywhere in a wrapped cause chain", () => {
    const root = new Error("build pending");
    root.name = "WorkerBuildInProgressError";
    const wrapped = new Error("itx expression evaluation failed", {
      cause: new Error("dynamic worker dispatch failed", { cause: root }),
    });
    expect(isProjectWorkerUnavailableDelivery(wrapped)).toBe(true);
  });

  it("terminates on a cyclic cause chain without matching", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(isProjectWorkerUnavailableDelivery(a)).toBe(false);
  });

  it("does not classify an ordinary handler error — that stays in the failing-event lane", () => {
    // A worker that is up but throws on one event is the case the
    // isolate-confirm-skip machinery exists for; broadening this matcher
    // would turn real userland bugs into invisible eternal retries.
    expect(isProjectWorkerUnavailableDelivery(new Error("TypeError: x is not a function"))).toBe(
      false,
    );
    expect(isProjectWorkerUnavailableDelivery(undefined)).toBe(false);
    expect(isProjectWorkerUnavailableDelivery("string error")).toBe(false);
  });
});
