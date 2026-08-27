import { describe, expect, test } from "vitest";
import type { AgentUiActivity } from "@iterate-com/ui/components/events/agent-ui-reducer";
import {
  formatActivitySummary,
  formatLiveActivityLabel,
  formatStepLine,
  streamingTail,
} from "./feed-format.ts";

const activity = (overrides: Partial<AgentUiActivity>): AgentUiActivity => ({
  kind: "activity",
  id: "activity-1",
  status: "done",
  steps: [],
  startedAtMs: 1000,
  ...overrides,
});

describe("formatActivitySummary", () => {
  test("matches the web feed phrasing", () => {
    const summary = formatActivitySummary(
      activity({
        endedAtMs: 8400,
        steps: [
          {
            kind: "code",
            id: "c1",
            executionId: "x",
            status: "done",
            code: "",
            startedAtMs: 0,
            expiresAtMs: 60_000,
          },
          {
            kind: "llm",
            id: "l1",
            llmRequestOffset: 1,
            status: "done",
            thinkingText: "",
            responseText: "",
            responseWindows: [],
            startedAtMs: 0,
            outcome: "completed",
          },
          {
            kind: "llm",
            id: "l2",
            llmRequestOffset: 2,
            status: "done",
            thinkingText: "",
            responseText: "",
            responseWindows: [],
            startedAtMs: 0,
            durationMs: 1000,
            outcome: "cancelled",
            cancelReason: "interrupted-by-user-input",
          },
        ],
      }),
    );
    expect(summary).toBe("Ran code 1× · 2 requests · interrupted · 7.4 s");
  });
});

describe("formatStepLine", () => {
  test("llm step shows model, tokens, duration", () => {
    expect(
      formatStepLine({
        kind: "llm",
        id: "l1",
        llmRequestOffset: 1,
        status: "done",
        model: "gpt-test",
        thinkingText: "",
        responseText: "",
        responseWindows: [],
        inputTokens: 1200,
        outputTokens: 80,
        durationMs: 1234,
        startedAtMs: 0,
        outcome: "completed",
      }),
    ).toBe("gpt-test · 1.2k → 80 tok · 1.2s");
  });

  test("user-interrupted step keeps model and tokens behind its label", () => {
    expect(
      formatStepLine({
        kind: "llm",
        id: "l1",
        llmRequestOffset: 1,
        status: "done",
        model: "gpt-test",
        thinkingText: "",
        responseText: "",
        responseWindows: [],
        inputTokens: 1200,
        outputTokens: 80,
        durationMs: 1234,
        startedAtMs: 0,
        outcome: "cancelled",
        cancelReason: "interrupted-by-user-input",
      }),
    ).toBe("Stopped for your new message · gpt-test · 1.2k → 80 tok · 1.2s");
  });

  test("expired step reads Request expired", () => {
    expect(
      formatStepLine({
        kind: "llm",
        id: "l1",
        llmRequestOffset: 1,
        status: "done",
        model: "gpt-test",
        thinkingText: "",
        responseText: "",
        responseWindows: [],
        startedAtMs: 0,
        outcome: "cancelled",
        cancelReason: "expired",
      }),
    ).toBe("Request expired · gpt-test");
  });

  test("cancelled without a recognized reason reads Request cancelled", () => {
    expect(
      formatStepLine({
        kind: "llm",
        id: "l1",
        llmRequestOffset: 1,
        status: "done",
        thinkingText: "",
        responseText: "",
        responseWindows: [],
        durationMs: 500,
        startedAtMs: 0,
        outcome: "cancelled",
      }),
    ).toBe("Request cancelled · 0.5s");
  });

  test("running code step is labeled Running code", () => {
    expect(
      formatStepLine({
        kind: "code",
        id: "c1",
        executionId: "x",
        status: "running",
        code: "return 1",
        startedAtMs: 0,
        expiresAtMs: 60_000,
      }),
    ).toBe("Running code");
  });
});

describe("formatLiveActivityLabel", () => {
  test("Thinking while reasoning tokens stream", () => {
    expect(
      formatLiveActivityLabel(
        activity({
          status: "running",
          steps: [
            {
              kind: "llm",
              id: "l1",
              llmRequestOffset: 1,
              status: "running",
              thinkingText: "hmm",
              responseText: "",
              responseWindows: [],
              startedAtMs: 0,
            },
          ],
        }),
      ),
    ).toBe("Thinking");
  });

  test("Waiting for a response before tokens and Working… between steps", () => {
    expect(
      formatLiveActivityLabel(
        activity({
          status: "running",
          steps: [
            {
              kind: "llm",
              id: "l1",
              llmRequestOffset: 1,
              status: "running",
              thinkingText: "",
              responseText: "",
              responseWindows: [],
              startedAtMs: 0,
            },
          ],
        }),
      ),
    ).toBe("Waiting for a response");
    expect(
      formatLiveActivityLabel(
        activity({
          status: "running",
          steps: [
            {
              kind: "llm",
              id: "l1",
              llmRequestOffset: 1,
              status: "done",
              thinkingText: "hmm",
              responseText: "hi",
              responseWindows: ["hi"],
              startedAtMs: 0,
              durationMs: 1000,
              outcome: "completed",
            },
          ],
        }),
      ),
    ).toBe("Working…");
  });

  test("Running code with one-decimal elapsed counter", () => {
    expect(
      formatLiveActivityLabel(
        activity({
          status: "running",
          steps: [
            {
              kind: "code",
              id: "c1",
              executionId: "x",
              status: "running",
              code: "return 1",
              startedAtMs: 1000,
              expiresAtMs: 60_000,
            },
          ],
        }),
        1900,
      ),
    ).toBe("Running code 0.9s");
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
