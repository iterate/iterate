/**
 * Must match `sanitizeToolName` in `@cloudflare/codemode` — codemode's `DynamicWorkerExecutor`
 * registers tools under that transform (`index.js` → `sanitizedFns[sanitizeToolName(name)]`).
 */
const JS_RESERVED = new Set([
  "abstract",
  "arguments",
  "await",
  "boolean",
  "break",
  "byte",
  "case",
  "catch",
  "char",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "double",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "final",
  "finally",
  "float",
  "for",
  "function",
  "goto",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "int",
  "interface",
  "let",
  "long",
  "native",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "short",
  "static",
  "super",
  "switch",
  "synchronized",
  "this",
  "throw",
  "throws",
  "transient",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "volatile",
  "while",
  "with",
  "yield",
]);

export function sanitizeToolName(name: string): string {
  if (!name) return "_";
  let sanitized = name.replace(/[-.\s]/g, "_");
  sanitized = sanitized.replace(/[^a-zA-Z0-9_$]/g, "");
  if (!sanitized) return "_";
  if (/^[0-9]/.test(sanitized)) sanitized = `_${sanitized}`;
  if (JS_RESERVED.has(sanitized)) sanitized = `${sanitized}_`;
  return sanitized;
}

/**
 * Codemode's `DynamicWorkerExecutor` registers tools under `sanitizeToolName(rawName)`.
 * Tool provider maps must use the same keys so `events.secrets_list(...)` resolves.
 */
export function uniqueSanitizedToolKey(rawName: string, usedKeys: Set<string>): string {
  const base = sanitizeToolName(rawName);
  let candidate = base;
  let n = 2;
  while (usedKeys.has(candidate)) {
    candidate = `${base}__${n++}`;
  }
  usedKeys.add(candidate);
  return candidate;
}
