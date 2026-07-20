export function llmResponseForDisplay(responseText: string, followingCode: string | undefined) {
  if (followingCode === undefined) return responseText;
  const response = responseText.trim();
  const fenced = /^```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)\n```$/.exec(response)?.[1];
  const generatedCode = fenced || response;
  return generatedCode.trim() === followingCode.trim() ? "" : responseText;
}
