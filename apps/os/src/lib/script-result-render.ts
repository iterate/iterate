// The ONE stringification a script settlement gets on its way into the
// agent's context (`renderScriptSettlement` in
// domains/agents/agent-processor-implementation.ts), extracted here so the
// feed's Result tab can compute the SAME text and check the rendered event
// for verbatim containment (agent-activity-rounds.tsx `renderIsTransformed`).
// Pure by design — importable from the client bundle, so keep processor and
// contract imports out of this module.

/**
 * A returned string renders as itself: JSON.stringify would escape every
 * newline and quote, turning a fetched page or file into one unreadable
 * escaped line the model pays to mentally unescape (seen live: an 8.8KB
 * worker.ts as a single escape-riddled JSON string). Non-strings keep the
 * pretty-printed JSON shape.
 */
export function stringifyScriptResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
}

/** Inline truncation at the configured history limit, with the advice notice
 * the agent sees appended past the cut. */
export function truncateScriptResult(text: string, historyLimit: number): string {
  if (text.length <= historyLimit) return text;
  return `${text.slice(0, historyLimit)}\n… truncated (${text.length} chars total; up to ${historyLimit} render inline — return less: slice arrays, pick fields)`;
}
