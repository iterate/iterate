import { describe, expect, test } from "vitest";
import { makeProcessorHarness } from "iterate/processors/testing";
import { ComputerProcessorContract } from "./computer-processor-contract.ts";
import { ComputerProcessor } from "./computer-processor-implementation.ts";

const PATH = "/computers/agents/demo";
const CONFIG = {
  defaultBackend: "worker-shell",
  defaultTimeoutMs: 30_000,
  workingDirectory: "/workspace",
} as const;

function harness() {
  return makeProcessorHarness<ComputerProcessorContract>({
    createProcessor: (deps) => new ComputerProcessor(deps),
    path: PATH,
  });
}

describe("ComputerProcessor", () => {
  test("reduces its agent-owned birth certificate and configuration", async () => {
    const h = harness();
    await h.play([
      "append",
      {
        type: "events.iterate.com/computer/created",
        payload: { agentPath: "/agents/demo", config: CONFIG },
      },
    ]);

    expect(h.state()).toMatchObject({
      birthCertificate: { agentPath: "/agents/demo", config: CONFIG },
      config: CONFIG,
    });
  });

  test("tracks one active command and its terminal outcome", async () => {
    const h = harness();
    const executionId = "00000000-0000-4000-8000-000000000001";
    await h.play([
      "append",
      {
        type: "events.iterate.com/computer/created",
        payload: { agentPath: "/agents/demo", config: CONFIG },
      },
      {
        type: "events.iterate.com/computer/execution-requested",
        payload: {
          backend: "worker-shell",
          command: "printf hello",
          executionId,
          incarnationId: "00000000-0000-4000-8000-000000000002",
          timeoutMs: 30_000,
        },
      },
      {
        type: "events.iterate.com/computer/execution-completed",
        payload: { executionId, exitCode: 0, syncStatus: "complete" },
      },
    ]);

    expect(h.state().activeExecution).toBeNull();
    expect(h.state().lastExecution).toEqual({
      executionId,
      exitCode: 0,
      status: "completed",
      syncStatus: "complete",
    });
  });

  test("classifies an interrupted command as abandoned after eviction", async () => {
    const h = harness();
    const executionId = "00000000-0000-4000-8000-000000000003";
    await h.play(
      [
        "append",
        {
          type: "events.iterate.com/computer/created",
          payload: { agentPath: "/agents/demo", config: CONFIG },
        },
        {
          type: "events.iterate.com/computer/execution-requested",
          payload: {
            backend: "worker-shell",
            command: "work",
            executionId,
            incarnationId: "00000000-0000-4000-8000-000000000004",
            timeoutMs: 30_000,
          },
        },
      ],
      ["crash"],
      [
        "append",
        {
          type: "events.iterate.com/computer/execution-abandoned",
          payload: { executionId, reason: "Durable Object restarted" },
        },
      ],
    );

    expect(h.state().activeExecution).toBeNull();
    expect(h.state().lastExecution).toEqual({
      executionId,
      reason: "Durable Object restarted",
      status: "abandoned",
    });
  });
});
