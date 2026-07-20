export function llmResponseForDisplay(responseText: string, hasParsedCode: boolean): string {
  return hasParsedCode ? "" : responseText;
}
