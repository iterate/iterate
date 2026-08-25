import { z } from "zod";

export const AgentLlmRequestCancelReason = z.enum(["interrupted-by-user-input", "expired"]);
export type AgentLlmRequestCancelReason = z.infer<typeof AgentLlmRequestCancelReason>;

/** The LLM message role a context item renders as. */
export type AgentContextRole = "system" | "developer" | "user" | "assistant";

/**
 * THE role derivation for agent context items — the one place a payload's
 * provenance becomes an LLM role. Role is a fact ABOUT the author, derived at
 * read time, never a claim stored in the payload:
 *
 * - keyed items are sections — standing instructions, system;
 * - a compaction summary is the agent's memory of prior context, not a fresh
 *   instruction — user;
 * - platform machinery, the project's config worker, agents, and their own
 *   scripts speak with application authority — developer;
 * - the model's own recorded output — assistant;
 * - everyone else — humans on any surface, every channel
 *   (slack/telegram/email/github), integrations, and every future actor —
 *   user: third-party text never gains instruction precedence from the way
 *   it arrived.
 *
 * The final `role` fallback covers events committed before actors were
 * required; a dropped actor can only ever demote (fails down to user).
 *
 * Lives here (not in the os fold) because the browser feed reducer
 * (packages/ui) and the mobile chat reducer derive the same roles; the
 * param is structural so contract payload unions and loosely-typed UI
 * payloads both fit.
 */
export function deriveRole(payload: {
  key?: string | undefined;
  compaction?: unknown;
  actor?: { type: string } | undefined;
  role?: AgentContextRole | undefined;
}): AgentContextRole {
  if (payload.key) return "system";
  if (payload.compaction) return "user";
  if (!payload.actor) return payload.role || "user";
  switch (payload.actor.type) {
    case "platform":
    case "agent":
    case "script":
    case "worker":
      return "developer";
    case "model":
      return "assistant";
    default:
      return "user";
  }
}

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
