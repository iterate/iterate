import { z } from "zod";

export const AgentLlmRequestCancelReason = z.enum([
  "interrupted-by-user-input",
  "durable-object-crashed",
]);
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
