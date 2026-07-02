import { describe, expect, test } from "vitest";
import type { AgentUiActivity } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { formatActivitySummary, formatStepLine, streamingTail } from "./feed-format.ts";

const activity = (overrides: Partial<AgentUiActivity>): AgentUiActivity => ({
  kind: "activity",
  id: "activity-1",
  status: "done",
  steps: [],
  startedAtMs: 1000,
  ...overrides,
});

describe("formatActivitySummary", () => {
  test("mirrors the web feed phrasing", () => {
    const summary = formatActivitySummary(
      activity({
        endedAtMs: 8400,
        steps: [
          { kind: "code", id: "c1", executionId: "x", status: "done", code: "", startedAtMs: 0 },
          { kind: "code", id: "c2", executionId: "y", status: "done", code: "", startedAtMs: 0 },
          {
            kind: "llm",
            id: "l1",
            llmRequestId: 1,
            status: "done",
            thinkingText: "",
            responseText: "",
            startedAtMs: 0,
          },
        ],
      }),
    );
    expect(summary).toBe("Ran code 2× · 1 request · 7.4s");
  });
});

describe("formatStepLine", () => {
  test("llm step shows model, tokens, duration", () => {
    expect(
      formatStepLine({
        kind: "llm",
        id: "l1",
        llmRequestId: 1,
        status: "done",
        model: "gpt-test",
        thinkingText: "",
        responseText: "",
        inputTokens: 1200,
        outputTokens: 80,
        durationMs: 1234,
        startedAtMs: 0,
      }),
    ).toBe("gpt-test · 1.2k → 80 tok · 1.2s");
  });

  test("running code step is marked running", () => {
    expect(
      formatStepLine({
        kind: "code",
        id: "c1",
        executionId: "x",
        status: "running",
        code: "return 1",
        startedAtMs: 0,
      }),
    ).toBe("Ran code · running");
  });
});

describe("streamingTail", () => {
  test("returns short text unchanged", () => {
    expect(streamingTail("hello")).toBe("hello");
  });

  test("keeps only the tail of long text", () => {
    const text = `${"x".repeat(700)}\ntail line`;
    const tail = streamingTail(text, 100);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("tail line")).toBe(true);
    expect(tail.length).toBeLessThanOrEqual(102);
  });
});
