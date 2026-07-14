import type { AgentUiTokenUsage } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { formatTokens } from "~/lib/feed-format.ts";

/**
 * Derive agent context-fullness + lifetime token totals from the reduced
 * tokenUsage state. `null` until a turn has reported usage. Rendered in the
 * Stream state vitals panel (not under the composer).
 */
export function readAgentTokenUsageVitals(tokenUsage: AgentUiTokenUsage) {
  const last = tokenUsage.lastReport;
  if (last == null) return null;
  const contextTokens = last.inputTokens + last.outputTokens;
  const contextPercent = Math.min(100, Math.round((contextTokens / last.maxContextTokens) * 100));
  return {
    contextTokens,
    contextPercent,
    maxContextTokens: last.maxContextTokens,
    model: last.model,
    totalInputTokens: tokenUsage.totalInputTokens,
    totalOutputTokens: tokenUsage.totalOutputTokens,
    totalCachedInputTokens: tokenUsage.totalCachedInputTokens,
    totalReasoningOutputTokens: tokenUsage.totalReasoningOutputTokens,
    contextLabel: `${formatTokens(contextTokens)}/${formatTokens(last.maxContextTokens)} (${contextPercent}%)`,
    inputLabel:
      formatTokens(tokenUsage.totalInputTokens) +
      (tokenUsage.totalCachedInputTokens > 0
        ? ` (${formatTokens(tokenUsage.totalCachedInputTokens)} cached)`
        : ""),
    outputLabel:
      formatTokens(tokenUsage.totalOutputTokens) +
      (tokenUsage.totalReasoningOutputTokens > 0
        ? ` (${formatTokens(tokenUsage.totalReasoningOutputTokens)} reasoning)`
        : ""),
    breakdown: [
      `model: ${last.model}`,
      `last request: ${last.inputTokens.toLocaleString()} in / ${last.outputTokens.toLocaleString()} out of ${last.maxContextTokens.toLocaleString()} context`,
      `lifetime input: ${tokenUsage.totalInputTokens.toLocaleString()} (${tokenUsage.totalCachedInputTokens.toLocaleString()} cached)`,
      `lifetime output: ${tokenUsage.totalOutputTokens.toLocaleString()} (${tokenUsage.totalReasoningOutputTokens.toLocaleString()} reasoning)`,
    ].join("\n"),
  };
}
