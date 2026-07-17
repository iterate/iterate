import { describe, expect, it } from "vitest";
import {
  ZERO_AGENT_RUNTIME,
  isAgentRuntimeZero,
  mergeAgentRuntimeChange,
  type AgentRuntime as AgentRuntimeRecord,
} from "@iterate-com/shared/agent-events";
import {
  AgentBinding,
  AgentMetadata,
  AgentMetadataPatch,
  AgentPath,
  applyAgentMetadataPatch,
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

describe("agent metadata", () => {
  it("trims values and rejects empty, oversized, unknown, and empty patches", () => {
    expect(
      AgentMetadataPatch.parse({
        title: "  Cattle research  ",
        activity: "  Comparing farms near Bath  ",
      }),
    ).toEqual({ title: "Cattle research", activity: "Comparing farms near Bath" });
    expect(() => AgentMetadataPatch.parse({ title: "   " })).toThrow();
    expect(() => AgentMetadataPatch.parse({ title: "x".repeat(121) })).toThrow();
    expect(() => AgentMetadataPatch.parse({ unknown: true })).toThrow();
    expect(() => AgentMetadataPatch.parse({})).toThrow();
  });

  it("distinguishes omitted, null, and false and preserves identity for no-ops", () => {
    const metadata = AgentMetadata.parse({
      title: "Cattle research",
      activity: "Comparing farms",
      waitingFor: "user_input",
      pinned: true,
    });
    expect(applyAgentMetadataPatch(metadata, AgentMetadataPatch.parse({ pinned: true }))).toBe(
      metadata,
    );
    expect(
      applyAgentMetadataPatch(
        metadata,
        AgentMetadataPatch.parse({ activity: null, waitingFor: null, pinned: false }),
      ),
    ).toEqual({ title: "Cattle research", pinned: false });
  });
});

describe("agent runtime", () => {
  it("derives every runtime count without double-counting requested work", () => {
    expect(
      deriveAgentRuntime(
        {
          activeScriptExecutionIds: ["script-a", "script-b"],
          context: { system: [{ key: "agent/system-prompt" }] },
          currentRequest: { phase: "requested" },
          llmRequests: {
            "4": { status: "requested" },
            "8": { status: "started" },
            "9": { status: "started" },
          },
          pendingTriggerOffset: 12,
        },
        "agent/system-prompt",
      ),
    ).toEqual({
      triggers: { pending: 1, runnable: 1 },
      llmRequests: { scheduled: 0, requested: 1, started: 2 },
      runningScripts: 2,
    });
  });

  it("keeps an unready trigger distinct from runnable work", () => {
    expect(
      deriveAgentRuntime(
        {
          activeScriptExecutionIds: [],
          context: { system: [] },
          currentRequest: null,
          llmRequests: {},
          pendingTriggerOffset: 2,
        },
        "agent/system-prompt",
      ),
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

  it("rejects a stale runtime generation and preserves exact no-op identity", () => {
    const current = { sinceOffset: 9, runtime: runtime({ runningScripts: 1 }) };
    expect(mergeAgentRuntimeChange(current, { sinceOffset: 5, runtime: ZERO_AGENT_RUNTIME })).toBe(
      current,
    );
    expect(
      mergeAgentRuntimeChange(current, {
        sinceOffset: 9,
        runtime: runtime({ runningScripts: 1 }),
      }),
    ).toBe(current);
    expect(
      mergeAgentRuntimeChange(current, { sinceOffset: 10, runtime: ZERO_AGENT_RUNTIME }),
    ).toEqual({ sinceOffset: 10, runtime: ZERO_AGENT_RUNTIME });
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
