import { describe, expect, test } from "vitest";
import { agentComputerPath, computerCreationEvents, normalizeComputerPath } from "./utils.ts";

describe("Computer paths and birth", () => {
  test("maps an agent path one-to-one under /computers", () => {
    expect(agentComputerPath("/agents/demo")).toBe("/computers/agents/demo");
    expect(agentComputerPath("/agents/slack/C123/thread")).toBe(
      "/computers/agents/slack/C123/thread",
    );
  });

  test("rejects standalone and codec-unstable Computer identities", () => {
    expect(() => normalizeComputerPath("/computers/shared")).toThrow(/agent-owned/);
    expect(() => normalizeComputerPath("/computers/agents/a b")).toThrow(/round-trip/);
  });

  test("rejects a birth certificate for another agent", () => {
    expect(() =>
      computerCreationEvents({
        agentPath: "/agents/other",
        path: "/computers/agents/demo",
        projectId: "prj_demo",
      }),
    ).toThrow(/does not belong/);
  });

  test("builds a configured birth certificate and processor subscription", () => {
    const events = computerCreationEvents({
      agentPath: "/agents/demo",
      path: "/computers/agents/demo",
      projectId: "prj_demo",
    });

    expect(events[0]).toMatchObject({
      type: "events.iterate.com/computer/created",
      payload: {
        agentPath: "/agents/demo",
        config: {
          defaultBackend: "worker-shell",
          defaultTimeoutMs: 30_000,
          workingDirectory: "/workspace",
        },
      },
    });
    expect(events[1]).toMatchObject({
      type: "events.iterate.com/stream/subscription-configured",
      payload: {
        receiver: {
          action: "processor-wake",
          expression: [
            "computers",
            ["get", "/computers/agents/demo"],
            "processor",
            "wakeStreamProcessor",
          ],
          processorSlug: "computer",
        },
      },
    });
  });
});
