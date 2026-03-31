function stripCodeFences(code: string) {
  const match = code.match(/^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/);
  return match ? match[1] : code;
}

export function normalizeCode(code: string) {
  const trimmed = stripCodeFences(code.trim());
  if (!trimmed.trim()) return "async () => {}";

  const source = trimmed
    .trim()
    .replace(/^export\s+default\s+/, "")
    .trim();

  if (
    /^(async\s*)?\([^)]*\)\s*=>/.test(source) ||
    /^(async\s*)?[a-zA-Z_$][\w$]*\s*=>/.test(source)
  ) {
    return source;
  }

  return `async () => {\n${source}\n}`;
}
