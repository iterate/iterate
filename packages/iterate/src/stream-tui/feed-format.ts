/**
 * Pure terminal formatting for agent feed items. Phrasing deliberately rhymes
 * with the web feed (apps/os/src/components/agent-feed.tsx): activities read
 * "Ran code 2× · 3 requests · 7.4 s", steps read "gpt-5 · 1.2s". Live status
 * is "Thinking" / "Waiting for a response" / "Running code 0.9s".
 */
import type {
  AgentUiActivity,
  AgentUiStep,
} from "@iterate-com/ui/components/events/agent-ui-reducer";

import { sliceText, textGroupSize, type StreamText } from "../../../shared/src/chunked-text.ts";

export { formatAgentUiActivitySummary as formatActivitySummary } from "@iterate-com/ui/components/events/agent-ui-reducer";

export function formatStepLine(step: AgentUiStep): string {
  if (step.kind === "code" && step.status === "running") {
    return "Running code";
  }
  const label =
    step.kind === "code"
      ? "Ran code"
      : step.cancelReason === "interrupted-by-user-input"
        ? "Stopped for your new message"
        : step.cancelReason === "expired"
          ? "Request expired"
          : step.outcome === "cancelled"
            ? "Request cancelled"
            : (step.model ?? "LLM request");
  const parts: string[] = [label];
  if (step.kind === "llm") {
    if (step.outcome === "cancelled" && step.model != null) parts.push(step.model);
    if (step.inputTokens != null || step.outputTokens != null) {
      parts.push(`${formatTokens(step.inputTokens)} → ${formatTokens(step.outputTokens)} tok`);
    }
    if (step.outcome === "failed") parts.push("failed");
  } else if (step.success === false) {
    parts.push("failed");
  }
  if (step.durationMs != null) parts.push(formatSeconds(step.durationMs));
  return parts.join(" · ");
}

/**
 * Live spinner label for the in-flight activity. Matches the web feed:
 * reasoning tokens → Thinking; otherwise Waiting for a response; code →
 * Running code (caller may append a live `0.9s` counter).
 */
export function formatLiveActivityLabel(
  activity: AgentUiActivity,
  nowMs: number = Date.now(),
): string {
  const running = activity.steps.filter((step) => step.status === "running");
  const code = running.findLast((step) => step.kind === "code");
  if (code != null) {
    const startedAtMs = code.startedAtMs;
    return `Running code ${formatSeconds(Math.max(0, nowMs - startedAtMs))}`;
  }
  const llm = running.findLast((step) => step.kind === "llm");
  if (llm == null || llm.kind !== "llm") {
    return "Working…";
  }
  if (llm.thinkingText.length > 0 && llm.responseText.length === 0) return "Thinking";
  return "Waiting for a response";
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
export function streamingTail(text: StreamText, maxChars = 600): string {
  let end = text.length;
  if (typeof text === "string") {
    end = text.trimEnd().length;
  } else {
    // Walk only trailing whitespace blocks; do not join a megabyte response
    // to display the terminal's final few hundred characters.
    for (let index = text.blockCount - 1; index >= 0; index--) {
      const block = text.groups[Math.floor(index / textGroupSize)]![index]!;
      const trimmed = block.trimEnd();
      end -= block.length - trimmed.length;
      if (trimmed.length > 0) break;
    }
  }
  if (end <= maxChars) return sliceText(text, 0, end);
  const tail = sliceText(text, end - maxChars, end);
  const firstNewline = tail.indexOf("\n");
  return `…${firstNewline === -1 ? tail : tail.slice(firstNewline)}`;
}
