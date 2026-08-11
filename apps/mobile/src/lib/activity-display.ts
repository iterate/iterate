export function llmResponseForDisplay(responseText: string, followingCode: string | undefined) {
  if (followingCode === undefined) return responseText;
  const response = responseText.trim();
  const fenced = /^```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)\n```$/.exec(response)?.[1];
  const generatedCode = fenced || response;
  return generatedCode.trim() === followingCode.trim() ? "" : responseText;
}

/** Whether raw LLM response text reads as code — parity copy of the os web
 * feed's heuristic (apps/os/src/lib/feed-format.ts looksLikeCode); change
 * both together. */
export function looksLikeCode(text: string): boolean {
  return (
    text.includes("```") ||
    /^\s*(async|await|function|const|let|import)\b/.test(text) ||
    /^[ \t]*<codemode(\s|>)/m.test(text)
  );
}
