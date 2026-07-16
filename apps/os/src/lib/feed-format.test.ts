import { describe, expect, test } from "vitest";
import type { AgentUiStep } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { agentBusyPhaseLabel, formatElapsedSeconds, liveActivityLabel } from "./feed-format.ts";

const llm = (overrides: Partial<Extract<AgentUiStep, { kind: "llm" }>> = {}): AgentUiStep => ({
  kind: "llm",
  id: "l1",
  llmRequestOffset: 1,
  status: "running",
  thinkingText: "",
  responseText: "",
  startedAtMs: 0,
  ...overrides,
});

const code = (overrides: Partial<Extract<AgentUiStep, { kind: "code" }>> = {}): AgentUiStep => ({
  kind: "code",
  id: "c1",
  executionId: "x",
  status: "running",
  code: "return 1",
  startedAtMs: 0,
  expiresAtMs: 60_000,
  ...overrides,
});

describe("liveActivityLabel", () => {
  test("says Thinking while reasoning tokens stream and response has not started", () => {
    expect(liveActivityLabel([llm({ thinkingText: "hmm" })])).toBe("Thinking");
  });

  test("says Waiting for a response before any tokens arrive", () => {
    expect(liveActivityLabel([llm()])).toBe("Waiting for a response");
  });

  test("says Waiting for a response while response tokens stream", () => {
    expect(liveActivityLabel([llm({ thinkingText: "hmm", responseText: "hello" })])).toBe(
      "Waiting for a response",
    );
    expect(liveActivityLabel([llm({ responseText: "hello" })])).toBe("Waiting for a response");
  });

  test("says Running code when a code step is in flight (no count)", () => {
    expect(liveActivityLabel([code()])).toBe("Running code");
    expect(liveActivityLabel([llm({ thinkingText: "x" }), code()])).toBe("Running code");
  });
});

describe("formatElapsedSeconds", () => {
  test("always one decimal place, no space, counts from zero", () => {
    expect(formatElapsedSeconds(0)).toBe("0.0s");
    expect(formatElapsedSeconds(900)).toBe("0.9s");
    expect(formatElapsedSeconds(12_340)).toBe("12.3s");
  });
});

describe("agentBusyPhaseLabel", () => {
  test("maps platform phases to the live phrasing", () => {
    expect(agentBusyPhaseLabel("llm")).toBe("waiting for a response");
    expect(agentBusyPhaseLabel(undefined)).toBe("waiting for a response");
    expect(agentBusyPhaseLabel("script")).toBe("running code");
  });
});
