export function responseWithoutParsedCode(responseText: string, parsedCodes: string[]): string {
  const normalizedCodes = new Set(parsedCodes.map((code) => code.trim()));
  return responseText
    .replace(/```[^\n]*\n([\s\S]*?)\n```/g, (fence, code: string) =>
      normalizedCodes.has(code.trim()) ? "" : fence,
    )
    .trim();
}
