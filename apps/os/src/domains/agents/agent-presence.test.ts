import { describe, expect, it } from "vitest";
import {
  ZERO_AGENT_RUNTIME,
  isAgentRuntimeZero,
  type AgentRuntime as AgentRuntimeRecord,
} from "@iterate-com/shared/agent-events";
import {
  AgentBinding,
  AgentSummary,
  AgentSummaryUpdate,
  AgentPath,
  applyAgentSummaryUpdate,
  deriveAgentDisplayState,
  deriveAgentRuntime,
} from "./agent-presence.ts";

const runtime = (patch: Partial<AgentRuntimeRecord> = {}): AgentRuntimeRecord => ({
  triggers: { ...ZERO_AGENT_RUNTIME.triggers, ...patch.triggers },
  llmRequests: { ...ZERO_AGENT_RUNTIME.llmRequests, ...patch.llmRequests },
  runningScripts: patch.runningScripts ?? 0,
});

describe("agent paths", () => {
  it("accepts only canonical routeable agent paths", () => {
    expect(AgentPath.parse("/agents/research/cattle-uk_1")).toBe("/agents/research/cattle-uk_1");
    for (const path of [
      "/agents/Research",
      "/agents/research//cattle",
      "/agents/research/",
      "/agents/research cattle",
      "/agents/research/has~tilde",
    ]) {
      expect(() => AgentPath.parse(path)).toThrow("agent path must be canonical");
    }
  });
});

describe("agent summary", () => {
  it("trims values and rejects empty, oversized, unknown, and empty updates", () => {
    expect(
      AgentSummaryUpdate.parse({
        title: "  Cattle research  ",
        description: "  Comparing farms around Bath.  ",
        activity: "  Comparing farms near Bath  ",
      }),
    ).toEqual({
      title: "Cattle research",
      description: "Comparing farms around Bath.",
      activity: "Comparing farms near Bath",
    });
    expect(() => AgentSummaryUpdate.parse({ title: "   " })).toThrow();
    expect(() => AgentSummaryUpdate.parse({ title: "x".repeat(121) })).toThrow();
    expect(() => AgentSummaryUpdate.parse({ summary: "legacy field" })).toThrow();
    expect(() => AgentSummaryUpdate.parse({ unknown: true })).toThrow();
    expect(() => AgentSummaryUpdate.parse({})).toThrow();
  });

  it("distinguishes omitted, null, and false and preserves identity for no-ops", () => {
    const summary = AgentSummary.parse({
      title: "Cattle research",
      description: "Comparing nearby farms.",
      activity: "Comparing farms",
      waitingFor: "user_input",
      pinned: true,
    });
    expect(applyAgentSummaryUpdate(summary, AgentSummaryUpdate.parse({ pinned: true }))).toBe(
      summary,
    );
    expect(
      applyAgentSummaryUpdate(
        summary,
        AgentSummaryUpdate.parse({
          description: null,
          activity: null,
          waitingFor: null,
          pinned: false,
        }),
      ),
    ).toEqual({ title: "Cattle research", pinned: false });
  });
});

describe("agent runtime", () => {
  it("derives every runtime count from the fold's single open-request slot", () => {
    expect(
      deriveAgentRuntime({
        activeScriptExecutions: [{ executionId: "script-a" }, { executionId: "script-b" }],
        contextItems: [{ kind: "section" }],
        openRequest: { requestedAtOffset: 4 },
        pendingLlmRequestTrigger: { offset: 12 },
      }),
    ).toEqual({
      triggers: { pending: 1, runnable: 1 },
      // No scheduled/started phases in the offset-identified request model:
      // the one open request counts as requested, the rest pin to 0.
      llmRequests: { scheduled: 0, requested: 1, started: 0 },
      runningScripts: 2,
    });
  });

  it("keeps a trigger without any system-role section distinct from runnable work", () => {
    expect(
      deriveAgentRuntime({
        activeScriptExecutions: [],
        contextItems: [],
        openRequest: null,
        pendingLlmRequestTrigger: { offset: 2 },
      }),
    ).toMatchObject({ triggers: { pending: 1, runnable: 0 } });
  });

  it("applies display precedence and only uses semantic waiting at zero runtime", () => {
    expect(deriveAgentDisplayState(runtime({ runningScripts: 1 }), "user_input")).toBe(
      "running_code",
    );
    expect(
      deriveAgentDisplayState(runtime({ llmRequests: { requested: 1, scheduled: 0, started: 0 } })),
    ).toBe("waiting_for_model");
    expect(
      deriveAgentDisplayState(runtime({ triggers: { pending: 1, runnable: 1 } }), "timer"),
    ).toBe("queued");
    // An unready trigger is retained as a projected diagnostic count but is not
    // presented as active progress without a bounded configuration obligation.
    expect(deriveAgentDisplayState(runtime({ triggers: { pending: 1, runnable: 0 } }))).toBe(
      "idle",
    );
    expect(deriveAgentDisplayState(ZERO_AGENT_RUNTIME, "external_event")).toBe(
      "waiting_for_external_event",
    );
    expect(deriveAgentDisplayState(ZERO_AGENT_RUNTIME)).toBe("idle");
    expect(isAgentRuntimeZero(ZERO_AGENT_RUNTIME)).toBe(true);
  });
});

describe("agent bindings", () => {
  it("strictly validates one normalized external origin", () => {
    expect(
      AgentBinding.parse({
        type: "slack_thread",
        connection: "team",
        channelId: "C123",
        threadTs: "123.45",
        channelName: "research",
      }),
    ).toEqual({
      type: "slack_thread",
      connection: "team",
      channelId: "C123",
      threadTs: "123.45",
      channelName: "research",
    });
    expect(() =>
      AgentBinding.parse({
        type: "email_thread",
        threadId: "thread-1",
        source: "guessed-from-path",
      }),
    ).toThrow();
  });

  it("bounds every external field and permits only HTTPS links", () => {
    expect(() =>
      AgentBinding.parse({
        type: "github_pull_request",
        connection: "github",
        installationId: "123",
        owner: "iterate",
        repo: "iterate",
        number: 42,
        url: "javascript:alert(1)",
      }),
    ).toThrow("HTTPS");
    expect(() =>
      AgentBinding.parse({
        type: "email_thread",
        threadId: "x".repeat(129),
      }),
    ).toThrow();
  });
});
