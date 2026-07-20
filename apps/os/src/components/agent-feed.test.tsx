// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { ZERO_AGENT_RUNTIME, type AgentRuntime } from "@iterate-com/shared/agent-events";
import type {
  AgentUiActivity,
  AgentUiLlmStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { AgentFeedItemRow, AgentLiveActivity } from "./agent-feed.tsx";

afterEach(() => {
  vi.useRealTimers();
});

function llmStep(
  offset: number,
  startedAtMs: number,
  overrides: Partial<AgentUiLlmStep> = {},
): AgentUiLlmStep {
  return {
    kind: "llm",
    id: `llm:${offset}`,
    llmRequestOffset: offset,
    status: "done",
    thinkingText: "",
    responseText: "",
    outcome: "completed",
    startedAtMs,
    ...overrides,
  };
}

function activity(overrides: Partial<AgentUiActivity>): AgentUiActivity {
  return {
    kind: "activity",
    id: "activity:test",
    status: "done",
    startedAtMs: 0,
    steps: [],
    ...overrides,
  };
}

function renderActivity(activity: AgentUiActivity, expanded = true): HTMLDivElement {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <AgentFeedItemRow
      item={activity}
      toggledIds={expanded ? new Set([activity.id]) : new Set()}
      onToggle={() => {}}
      onInspectLlmRequest={() => {}}
      onInspectScriptExecution={() => {}}
    />,
  );
  return container;
}

function renderLiveActivity(
  live: AgentUiActivity,
  runtime: AgentRuntime = ZERO_AGENT_RUNTIME,
): HTMLDivElement {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <AgentLiveActivity live={live} runtime={runtime} toggledIds={new Set()} onToggle={() => {}} />,
  );
  return container;
}

test("the live tail shows accumulated work above a timer for the current LLM phase", () => {
  vi.useFakeTimers();
  const now = Date.UTC(2026, 6, 15, 22, 0, 0);
  vi.setSystemTime(now);
  const live = activity({
    status: "running",
    startedAtMs: now - 8_000,
    steps: [
      {
        kind: "code",
        id: "code:1",
        executionId: "execution:1",
        status: "done",
        code: "return 1",
        success: true,
        startedAtMs: now - 8_000,
        durationMs: 1_000,
        expiresAtMs: now + 60_000,
      },
      {
        kind: "llm",
        id: "llm:1",
        llmRequestOffset: 10,
        status: "done",
        thinkingText: "",
        responseText: "done",
        outcome: "completed",
        startedAtMs: now - 6_000,
        durationMs: 2_000,
      },
      {
        kind: "llm",
        id: "llm:2",
        llmRequestOffset: 20,
        status: "running",
        thinkingText: "Considering the next step",
        responseText: "",
        startedAtMs: now - 3_400,
      },
    ],
  });

  const container = renderLiveActivity(live);
  const summary = container.querySelector('[data-testid="agent-live-summary"]');
  const status = container.querySelector('[data-testid="agent-live-status"]');

  expect(summary?.textContent).toBe("Ran code 1× · 1 request");
  expect(status?.textContent).toContain("Thinking 3.4s");
  expect(summary?.compareDocumentPosition(status!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

test("the accumulated line does not claim that the active operation already finished", () => {
  vi.useFakeTimers();
  const now = Date.UTC(2026, 6, 15, 22, 0, 0);
  vi.setSystemTime(now);
  const live = activity({
    status: "running",
    startedAtMs: now - 500,
    steps: [
      {
        kind: "code",
        id: "code:active",
        executionId: "execution:active",
        status: "running",
        code: "await doWork()",
        startedAtMs: now - 500,
        expiresAtMs: now + 60_000,
      },
    ],
  });

  const container = renderLiveActivity(live);

  expect(container.querySelector('[data-testid="agent-live-summary"]')).toBeNull();
  expect(container.querySelector('[data-testid="agent-live-status"]')?.textContent).toContain(
    "Running code",
  );
  expect(container.textContent).not.toContain("Ran code");
});

test("an expired request renders as a failed activity with its reason labeled", () => {
  const startedAtMs = Date.UTC(2026, 6, 16, 14, 41, 23);
  const expired = renderActivity(
    activity({
      startedAtMs,
      endedAtMs: startedAtMs + 31_000,
      steps: [
        llmStep(1, startedAtMs, {
          model: "openai/gpt-5.6-sol",
          outcome: "cancelled",
          cancelReason: "expired",
          durationMs: 5_000,
        }),
      ],
    }),
  );
  const summary = expired.querySelector('button[title^="Agent activity"]');

  expect(summary?.textContent).toBe("1 request · failed · 31 s");
  expect(summary?.querySelector("svg.lucide-circle-alert")).not.toBeNull();
  expect(expired.textContent).toContain("Request expiredopenai/gpt-5.6-sol · 5 s");
});

test("known and unknown cancellations render distinctly inside a failed activity", () => {
  const startedAtMs = Date.UTC(2026, 6, 16, 14, 41, 23);
  const interrupted = renderActivity(
    activity({
      startedAtMs,
      endedAtMs: startedAtMs + 5_000,
      steps: [
        llmStep(1, startedAtMs, {
          outcome: "cancelled",
          cancelReason: "interrupted-by-user-input",
          responseText: "partial",
        }),
        llmStep(3, startedAtMs + 1, { outcome: "cancelled" }),
      ],
    }),
  );

  expect(interrupted.querySelector('button[title^="Agent activity"]')?.textContent).toBe(
    "2 requests · failed · 5 s",
  );
  expect(interrupted.querySelector("svg.lucide-ban")).not.toBeNull();
  expect(interrupted.textContent).toContain("Stopped for your new message");
  expect(interrupted.textContent).toContain("Request cancelled");
});

test("a pending request without a running step shows its own status, not a finished operation's", () => {
  const now = Date.UTC(2026, 6, 15, 22, 0, 0);
  const live = activity({
    status: "running",
    startedAtMs: now - 8_000,
    steps: [
      {
        kind: "llm",
        id: "llm:completed",
        llmRequestOffset: 10,
        status: "done",
        thinkingText: "",
        responseText: "done",
        outcome: "completed",
        startedAtMs: now - 8_000,
        durationMs: 2_000,
      },
    ],
  });

  const container = renderLiveActivity(live, {
    ...ZERO_AGENT_RUNTIME,
    llmRequests: { scheduled: 0, requested: 1, started: 0 },
  });

  const status = container.querySelector<HTMLButtonElement>('[data-testid="agent-live-status"]');
  expect(status?.disabled).toBe(true);
  expect(status?.textContent).toContain("Waiting for a response");
  expect(status?.querySelector("svg.lucide-chevron-right")).toBeNull();
});

test("a scheduled LLM request stays queued until the request starts", () => {
  const live = activity({
    status: "running",
    startedAtMs: Date.UTC(2026, 6, 15, 22, 0, 0),
  });
  const container = renderLiveActivity(live, {
    ...ZERO_AGENT_RUNTIME,
    llmRequests: { scheduled: 1, requested: 0, started: 0 },
  });

  const status = container.querySelector('[data-testid="agent-live-status"]');
  expect(status?.textContent).toContain("Queued");
  expect(status?.textContent).not.toContain("Waiting for a response");
});

test("a running code row stops counting and fails visibly at its absolute deadline", () => {
  vi.useFakeTimers();
  const now = Date.UTC(2026, 6, 15, 22, 0, 20);
  vi.setSystemTime(now);
  const startedAtMs = now - 10_000;
  const live = activity({
    status: "running",
    startedAtMs,
    steps: [
      {
        kind: "code",
        id: "code:expired",
        executionId: "execution:expired",
        status: "running",
        code: "await neverReturns()",
        startedAtMs,
        expiresAtMs: startedAtMs + 5_000,
      },
    ],
  });

  const container = renderLiveActivity(live);
  const status = container.querySelector('[data-testid="agent-live-status"]');

  expect(status?.textContent).toContain("Code deadline exceeded 5.0s");
  expect(status?.querySelector("svg.lucide-circle-alert")).not.toBeNull();
  expect(status?.querySelector("svg.lucide-loader-circle")).toBeNull();
});

test("expanded activity rows are themselves inspector buttons without inline trace details", () => {
  const startedAtMs = Date.UTC(2026, 6, 15, 22, 6, 0);
  const inspected = activity({
    startedAtMs,
    endedAtMs: startedAtMs + 5_000,
    steps: [
      {
        kind: "llm",
        id: "llm:53",
        llmRequestOffset: 53,
        status: "done",
        model: "openai/gpt-5.6-sol",
        thinkingText: "",
        responseText: "",
        outcome: "completed",
        startedAtMs,
        durationMs: 2_942,
        inputTokens: 6_601,
        outputTokens: 72,
      },
      {
        kind: "code",
        id: "code:53",
        executionId: "agent-output:53",
        status: "done",
        code: "return { ok: true }",
        success: true,
        startedAtMs: startedAtMs + 3_000,
        durationMs: 2_000,
        expiresAtMs: startedAtMs + 60_000,
      },
    ],
  });

  const container = renderActivity(inspected);

  const llmRow = container.querySelector('[data-testid="agent-feed-inspect-llm-request"]');
  const scriptRow = container.querySelector('[data-testid="agent-feed-inspect-script-execution"]');
  expect(llmRow?.tagName).toBe("BUTTON");
  expect(scriptRow?.tagName).toBe("BUTTON");
  expect(llmRow?.textContent).toContain("openai/gpt-5.6-sol6.6k → 72 tok · 2.9 s");
  expect(scriptRow?.textContent).toContain("Ran codeStarted ");
  expect(scriptRow?.textContent).toContain(" · 2 s");
  expect(container.textContent).not.toContain("View trace");
  expect(container.textContent).not.toContain('"status": "completed"');
});

test("failed script outcomes are explicit in both collapsed and expanded activity rows", () => {
  const startedAtMs = Date.UTC(2026, 6, 15, 22, 6, 0);
  const failed = activity({
    startedAtMs,
    endedAtMs: startedAtMs + 119_500,
    steps: [
      {
        kind: "code",
        id: "code:failed",
        executionId: "agent-output:failed",
        status: "done",
        code: "throw new Error('boom')",
        success: false,
        errorMessage: "boom",
        startedAtMs,
        durationMs: 119_500,
        expiresAtMs: startedAtMs + 120_000,
      },
    ],
  });
  const container = renderActivity(failed);

  expect(container.textContent).toContain("Ran code 1× · 0 requests · failed · 2m 0s");
  expect(
    container.querySelector('[data-testid="agent-feed-inspect-script-execution"]')?.textContent,
  ).toMatch(/Code failedStarted .* · 2m 0s/);
});
