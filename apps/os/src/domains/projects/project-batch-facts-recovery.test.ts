import { isStreamReceiverUnavailableError } from "iterate/processors";
import { describe, expect, it, vi } from "vitest";
import {
  captureProjectBatchFactsIndex,
  indexProjectBatchFactsWithRecovery,
  type ProjectBatchFactsIndexInput,
} from "./project-batch-facts-recovery.ts";

const facts: ProjectBatchFactsIndexInput = {
  stream: {
    at: "2026-07-28T14:14:03.000Z",
    maxOffset: 7,
    path: "/e2e/wire",
    type: "events.iterate.test/wire/probe",
  },
};

const lifecycleError = (message: string) =>
  Object.assign(new Error(message), { durableObjectReset: true });

describe("captureProjectBatchFactsIndex", () => {
  it("returns an explicit availability result before RPC strips reset flags", async () => {
    const reset = lifecycleError(
      "Durable Object storage operation exceeded timeout which caused object to be reset.",
    );

    await expect(
      captureProjectBatchFactsIndex(async () => {
        throw reset;
      }),
    ).resolves.toEqual({
      reason:
        "Error: Durable Object storage operation exceeded timeout which caused object to be reset.",
      status: "unavailable",
    });
  });

  it("does not classify an application failure as availability", async () => {
    const applicationError = new Error("invalid stream path");

    await expect(
      captureProjectBatchFactsIndex(async () => {
        throw applicationError;
      }),
    ).rejects.toBe(applicationError);
  });
});

describe("indexProjectBatchFactsWithRecovery", () => {
  it("re-acquires a fresh Project after an explicit unavailable result", async () => {
    const first = vi.fn(async () => ({
      reason: "Error: code updated",
      status: "unavailable" as const,
    }));
    const second = vi.fn(async () => ({ status: "indexed" as const }));
    const getProject = vi
      .fn()
      .mockReturnValueOnce({ indexCommittedBatchFacts: first })
      .mockReturnValueOnce({ indexCommittedBatchFacts: second });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(
      indexProjectBatchFactsWithRecovery({
        facts,
        getProject,
        projectId: "prj_test",
      }),
    ).resolves.toBeUndefined();

    expect(getProject).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledWith(facts);
    expect(second).toHaveBeenCalledWith(facts);
    expect(info).toHaveBeenCalledWith(
      "project batch-facts index re-acquiring after Durable Object reset",
      {
        projectId: "prj_test",
        reason: "Error: code updated",
      },
    );
  });

  it("accepts a fulfilled void result from a pre-result rollout target", async () => {
    const indexCommittedBatchFacts = vi.fn(async () => undefined);

    await expect(
      indexProjectBatchFactsWithRecovery({
        facts,
        getProject: () => ({ indexCommittedBatchFacts }),
        projectId: "prj_test",
      }),
    ).resolves.toBeUndefined();

    expect(indexCommittedBatchFacts).toHaveBeenCalledOnce();
  });

  it("turns a second availability interruption into receiver unavailability", async () => {
    const firstReset = lifecycleError("code updated");
    const getProject = vi
      .fn()
      .mockReturnValueOnce({
        indexCommittedBatchFacts: async () => {
          throw firstReset;
        },
      })
      .mockReturnValueOnce({
        indexCommittedBatchFacts: async () => ({
          reason: "Error: storage reset again",
          status: "unavailable" as const,
        }),
      });
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    let caught: unknown;
    try {
      await indexProjectBatchFactsWithRecovery({
        facts,
        getProject,
        projectId: "prj_test",
      });
    } catch (error) {
      caught = error;
    }

    expect(isStreamReceiverUnavailableError(caught)).toBe(true);
    expect(caught).toMatchObject({
      message:
        'Project "prj_test" could not index committed batch facts after two availability ' +
        "attempts: Error: storage reset again",
    });
  });

  it("propagates an application failure without replaying it", async () => {
    const applicationError = new Error("invalid stream path");
    const getProject = vi.fn(() => ({
      indexCommittedBatchFacts: async () => {
        throw applicationError;
      },
    }));

    await expect(
      indexProjectBatchFactsWithRecovery({
        facts,
        getProject,
        projectId: "prj_test",
      }),
    ).rejects.toBe(applicationError);
    expect(getProject).toHaveBeenCalledOnce();
  });
});
