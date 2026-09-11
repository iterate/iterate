import { describe, expect, it } from "vitest";
import {
  ZERO_AGENT_RUNTIME,
  deriveAgentDisplayState,
  isAgentRuntimeZero,
  type AgentRuntime,
} from "./agent-events.ts";

const runtime = (patch: Partial<AgentRuntime> = {}): AgentRuntime => ({
  triggers: { ...ZERO_AGENT_RUNTIME.triggers, ...patch.triggers },
  llmRequests: { ...ZERO_AGENT_RUNTIME.llmRequests, ...patch.llmRequests },
  runningScripts: patch.runningScripts ?? 0,
});

describe("agent display state", () => {
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
