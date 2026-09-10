/** Whether raw LLM response text reads as code — parity copy of the os web
 * feed's heuristic (packages/ui/src/components/events/feed-format.ts looksLikeCode); change
 * both together. */
export function looksLikeCode(text: string): boolean {
  return (
    text.includes("```") ||
    /^\s*(async|await|function|const|let|import)\b/.test(text) ||
    /^[ \t]*<codemode(\s|>)/m.test(text)
  );
}
