import { z } from "zod";

export const AgentLlmRequestCancelReason = z.enum(["interrupted-by-user-input", "expired"]);
export type AgentLlmRequestCancelReason = z.infer<typeof AgentLlmRequestCancelReason>;

export const AGENT_SUMMARY_UPDATED_EVENT_TYPE = "events.iterate.com/agent/summary-updated";
export const AGENT_BINDING_SET_EVENT_TYPE = "events.iterate.com/agent/binding-set";

const AgentRuntimeCount = z.number().int().nonnegative();

/** Exact runtime-derived work counts. Presentation may reduce these counts but
 * must never replace the recorded values with guesses. */
export const AgentRuntime = z.strictObject({
  triggers: z.strictObject({
    pending: AgentRuntimeCount,
    runnable: AgentRuntimeCount,
  }),
  llmRequests: z.strictObject({
    scheduled: AgentRuntimeCount,
    requested: AgentRuntimeCount,
    started: AgentRuntimeCount,
  }),
  runningScripts: AgentRuntimeCount,
});
export type AgentRuntime = z.infer<typeof AgentRuntime>;

export const ZERO_AGENT_RUNTIME: AgentRuntime = Object.freeze({
  triggers: Object.freeze({ pending: 0, runnable: 0 }),
  llmRequests: Object.freeze({ scheduled: 0, requested: 0, started: 0 }),
  runningScripts: 0,
});

export function agentRuntimesEqual(a: AgentRuntime, b: AgentRuntime): boolean {
  return (
    a.triggers.pending === b.triggers.pending &&
    a.triggers.runnable === b.triggers.runnable &&
    a.llmRequests.scheduled === b.llmRequests.scheduled &&
    a.llmRequests.requested === b.llmRequests.requested &&
    a.llmRequests.started === b.llmRequests.started &&
    a.runningScripts === b.runningScripts
  );
}

export function isAgentRuntimeZero(runtime: AgentRuntime): boolean {
  return agentRuntimesEqual(runtime, ZERO_AGENT_RUNTIME);
}

/** An agent-authored waiting requirement: what the agent said it is parked on. */
export type AgentWaitingFor = "user_input" | "external_event" | "timer";

/**
 * What a UI says an agent is doing. The three work states come from the
 * runtime counts; the three waiting states come from the agent's own summary
 * and only apply once the runtime is idle.
 */
export type AgentDisplayState =
  | "running_code"
  | "waiting_for_model"
  | "queued"
  | "waiting_for_user_input"
  | "waiting_for_external_event"
  | "waiting_for_timer"
  | "idle";

/** Deterministic work state only. Agent-authored waiting requirements are a
 * separate attention signal and must never replace this runtime truth in UI. */
export function deriveAgentRuntimeDisplayState(runtime: AgentRuntime | undefined) {
  const current = runtime ?? ZERO_AGENT_RUNTIME;
  if (current.runningScripts > 0) return "running_code";
  if (current.llmRequests.requested > 0 || current.llmRequests.started > 0) {
    return "waiting_for_model";
  }
  if (current.llmRequests.scheduled > 0 || current.triggers.runnable > 0) return "queued";
  return "idle";
}

/** The full display state: the runtime work state, else the agent-authored waiting reason, else idle. */
export function deriveAgentDisplayState(
  runtime: AgentRuntime | undefined,
  waitingFor?: AgentWaitingFor,
): AgentDisplayState {
  const runtimeState = deriveAgentRuntimeDisplayState(runtime);
  if (runtimeState !== "idle") return runtimeState;
  if (waitingFor === "user_input") return "waiting_for_user_input";
  if (waitingFor === "external_event") return "waiting_for_external_event";
  if (waitingFor === "timer") return "waiting_for_timer";
  return "idle";
}
