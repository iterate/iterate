// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { ZERO_AGENT_RUNTIME, type AgentRuntime } from "@iterate-com/shared/agent-events";
import type {
  AgentUiActivity,
  AgentUiLlmStep,
  AgentUiMessageItem,
} from "@iterate-com/ui/components/events/agent-ui-reducer";
import { AgentFeedItemRow, AgentLiveActivity } from "./agent-feed.tsx";
import { buildRoundMetaYaml } from "~/lib/agent-round-meta-yaml.ts";

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
    responseWindows: [],
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

function renderMessage(item: AgentUiMessageItem): HTMLDivElement {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <AgentFeedItemRow item={item} toggledIds={new Set()} onToggle={() => {}} />,
  );
  return container;
}

test("a failed reference resolution marks the exact sent pill", () => {
  const container = renderMessage({
    kind: "user",
    id: "user-1",
    text: "Use @AGENTS.md",
    timestampMs: 0,
    richContent: {
      version: 1,
      nodes: [
        { type: "text", text: "Use " },
        {
          type: "reference",
          occurrenceId: "ref-one",
          display: "@AGENTS.md",
          target: { kind: "config-repo-file", repoPath: "/repos/config", path: "AGENTS.md" },
        },
      ],
    },
    referenceResolutions: { "ref-one": { status: "missing" } },
  });
  const pill = container.querySelector('[data-reference-kind="config-repo-file"]');

  expect(pill?.getAttribute("data-reference-resolution")).toBe("missing");
  expect(pill?.getAttribute("aria-label")).toBe(
    "@AGENTS.md: File was not found when this message was processed",
  );
});

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
        responseWindows: ["done"],
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
        responseWindows: [],
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

test("a collapsed stream wake run shows its count on the final wake", () => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <AgentFeedItemRow
      item={{
        kind: "stream-woken",
        id: "stream-woken-99",
        text: "Stream durable object woke",
        timestampMs: Date.UTC(2026, 6, 22),
        count: 99,
      }}
      toggledIds={new Set()}
      onToggle={() => {}}
    />,
  );

  expect(container.querySelector('[data-testid="agent-feed-stream-woken"]')?.textContent).toContain(
    "Stream durable object woke (99)",
  );
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
  // A single llm-only round renders its stat line in place (no tabs, no
  // "Round 1" header) — mirroring mobile's LlmStepView.
  expect(expired.textContent).not.toContain("Round 1");
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
          responseWindows: ["partial"],
        }),
        llmStep(3, startedAtMs + 1, { outcome: "cancelled" }),
      ],
    }),
  );

  expect(interrupted.querySelector('button[title^="Agent activity"]')?.textContent).toBe(
    "2 requests · failed · 5 s",
  );
  expect(interrupted.querySelector("svg.lucide-circle-alert")).not.toBeNull();
  // Two llm-only rounds: each gets a "Round N" header whose suffix carries
  // the cancellation reason.
  expect(interrupted.textContent).toContain("Round 1Stopped for your new message");
  expect(interrupted.textContent).toContain("Round 2Request cancelled");
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
        responseWindows: ["done"],
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

test("a single settled round expands straight to Script | Result | Meta tabs", () => {
  const startedAtMs = Date.UTC(2026, 6, 15, 22, 6, 0);
  const inspected = activity({
    startedAtMs,
    endedAtMs: startedAtMs + 5_000,
    steps: [
      llmStep(53, startedAtMs, {
        model: "openai/gpt-5.6-sol",
        durationMs: 2_942,
        inputTokens: 6_601,
        outputTokens: 72,
      }),
      {
        kind: "code",
        id: "code:53",
        executionId: "agent-output:53",
        status: "done",
        code: "return { ok: true }",
        result: { ok: true },
        success: true,
        startedAtMs: startedAtMs + 3_000,
        durationMs: 2_000,
        expiresAtMs: startedAtMs + 60_000,
      },
    ],
  });

  const container = renderActivity(inspected);

  // One round: no "Round 1" header, the tab bar renders directly, and the
  // llm request's stats no longer spend a feed row — they live in Meta.
  expect(container.textContent).not.toContain("Round 1");
  const tabLabels = [...container.querySelectorAll('[data-slot="tabs-trigger"]')].map(
    (tab) => tab.textContent,
  );
  expect(tabLabels).toEqual(["Script", "Result", "Meta"]);
  expect(container.textContent).not.toContain("6.6k → 72 tok");
  // Script is the default tab: the submitted code's execution trace remains
  // one click away.
  expect(
    container.querySelector('[data-testid="agent-feed-inspect-script-execution"]')?.tagName,
  ).toBe("BUTTON");
});

test("a multi-round activity collapses each round to a header row", () => {
  const startedAtMs = Date.UTC(2026, 6, 15, 22, 6, 0);
  const codeStep = (id: number, offsetMs: number) =>
    ({
      kind: "code",
      id: `code:${id}`,
      executionId: `agent-output:${id}`,
      status: "done",
      code: `return ${id}`,
      success: true,
      startedAtMs: startedAtMs + offsetMs,
      durationMs: 2_000,
      expiresAtMs: startedAtMs + 60_000,
    }) as const;
  const container = renderActivity(
    activity({
      startedAtMs,
      endedAtMs: startedAtMs + 20_000,
      steps: [
        llmStep(10, startedAtMs, { model: "openai/gpt-5.6-sol" }),
        { ...codeStep(1, 3_000), activitySummary: "Searching the five most recent emails" },
        llmStep(20, startedAtMs + 6_000, { model: "openai/gpt-5.6-sol" }),
        codeStep(2, 9_000),
      ],
    }),
  );

  const rounds = [...container.querySelectorAll('[data-testid="agent-feed-round"]')];
  expect(rounds.map((round) => round.textContent)).toMatchObject([
    expect.stringContaining("Round 1"),
    expect.stringContaining("Round 2"),
  ]);
  // A round with a summary activity shows it instead of the bare start time…
  expect(rounds[0]?.textContent).toBe("Round 1Searching the five most recent emails · 2 s");
  // …and one without falls back to when it started.
  expect(rounds[1]?.textContent).toMatch(/Round 2Started \d/);
  expect(rounds[1]?.textContent).toContain(" · 2 s");
  // Collapsed rounds: no tab bars, no inline code or llm stats.
  expect(container.querySelector('[data-slot="tabs-trigger"]')).toBeNull();
  expect(container.textContent).not.toContain("return 1");
  expect(container.textContent).not.toContain("openai/gpt-5.6-sol");
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
  // The failed run settled with an error, so the single round offers a
  // Result tab alongside Script and Meta.
  const tabLabels = [...container.querySelectorAll('[data-slot="tabs-trigger"]')].map(
    (tab) => tab.textContent,
  );
  expect(tabLabels).toEqual(["Script", "Result", "Meta"]);
});

test("the Meta yaml carries the round stats and the replayed prompt", () => {
  const startedAtMs = Date.UTC(2026, 6, 15, 22, 6, 0);
  const yaml = buildRoundMetaYaml(
    llmStep(53, startedAtMs, {
      model: "openai/gpt-5.6-sol",
      durationMs: 2_942,
      inputTokens: 6_601,
      outputTokens: 72,
    }),
    {
      kind: "code",
      id: "code:53",
      executionId: "agent-output:53",
      status: "done",
      code: "return 1",
      success: true,
      startedAtMs,
      durationMs: 2_000,
      expiresAtMs: startedAtMs + 60_000,
    },
    {
      messages: [
        { role: "system", content: "You are an agent." },
        { role: "user", content: "Line one\nLine two" },
      ],
      reconstructed: false,
    },
  );

  expect(yaml).toContain("model: openai/gpt-5.6-sol");
  expect(yaml).toContain("duration: 2.9s");
  expect(yaml).toContain("inputTokens: 6601");
  expect(yaml).toContain("prompt: # 2 messages, 34 chars");
  // Multiline prompt content renders as a readable block scalar.
  expect(yaml).toContain("content: |-");
  expect(yaml).toContain("Line two");
});
