/**
 * Pure terminal formatting for agent feed items. Phrasing deliberately rhymes
 * with the web feed (apps/os/src/components/agent-feed.tsx): activities read
 * "Ran code 2× · 3 requests · 7.4s", steps read "gpt-5 · 1.2s".
 */
import type {
  AgentUiActivity,
  AgentUiStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";

export function formatActivitySummary(activity: AgentUiActivity): string {
  const codeCount = activity.steps.filter((step) => step.kind === "code").length;
  const requestCount = activity.steps.filter((step) => step.kind === "llm").length;
  const interrupted = activity.steps.some(
    (step) => step.kind === "llm" && step.outcome === "cancelled",
  );
  const parts: string[] = [];
  if (codeCount > 0) parts.push(`Ran code ${codeCount}×`);
  parts.push(`${requestCount} request${requestCount === 1 ? "" : "s"}`);
  if (interrupted) parts.push("interrupted");
  const totalMs =
    activity.endedAtMs == null ? null : Math.max(0, activity.endedAtMs - activity.startedAtMs);
  if (totalMs != null && totalMs > 0) parts.push(formatSeconds(totalMs));
  return parts.join(" · ");
}

export function formatStepLine(step: AgentUiStep): string {
  const label = step.kind === "code" ? "Ran code" : (step.model ?? step.provider ?? "LLM request");
  const parts: string[] = [label];
  if (step.kind === "llm") {
    if (step.inputTokens != null || step.outputTokens != null) {
      parts.push(`${formatTokens(step.inputTokens)} → ${formatTokens(step.outputTokens)} tok`);
    }
    if (step.outcome === "failed") parts.push("failed");
    if (step.outcome === "cancelled") parts.push("interrupted");
  } else if (step.success === false) {
    parts.push("failed");
  }
  if (step.durationMs != null) parts.push(formatSeconds(step.durationMs));
  if (step.status === "running") parts.push("running");
  return parts.join(" · ");
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTokens(count: number | undefined): string {
  if (count == null) return "?";
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}

/** The last `maxChars` of streamed text, trimmed to whole lines where possible. */
export function streamingTail(text: string, maxChars = 600): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= maxChars) return trimmed;
  const tail = trimmed.slice(-maxChars);
  const firstNewline = tail.indexOf("\n");
  return `…${firstNewline === -1 ? tail : tail.slice(firstNewline)}`;
}
