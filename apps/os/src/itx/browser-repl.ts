import { RpcTarget } from "capnweb";

export const DEFAULT_BROWSER_REPL_CODE = "await itx.projects.list({ limit: 5 })";

export type BrowserReplEntry = {
  code: string;
  consoleOutput: string;
  output: string;
  outputLanguage: "json" | "text";
  result?: unknown;
  status: "error" | "success";
};

export function createBrowserReplScope(scope?: Record<string, unknown>): Record<string, unknown> {
  // `vars` is always in scope so the catalogue examples (apps/os/src/itx/
  // examples.ts) run unchanged in the REPL: scripts read parameters from
  // `vars` and every other runtime injects it the same way. Assign your own
  // (`const vars = { … }`) to parameterize a snippet by hand.
  return { RpcTarget, vars: {}, ...scope };
}

export function browserReplExternalScopesEqual(
  first?: Record<string, unknown>,
  second?: Record<string, unknown>,
) {
  const firstKeys = Object.keys(first ?? {});
  const secondKeys = Object.keys(second ?? {});
  if (firstKeys.length !== secondKeys.length) return false;

  for (const key of firstKeys) {
    if (!Object.prototype.hasOwnProperty.call(second ?? {}, key)) return false;
    if (!Object.is(first?.[key], second?.[key])) return false;
  }

  return true;
}

export async function evalBrowserReplCode(input: { code: string; itx: unknown; env?: object }) {
  return await compileBrowserReplFunction(input.code)(input.itx, input.env ?? {}, {});
}

export async function evalBrowserReplSessionCode(input: {
  code: string;
  itx: unknown;
  env?: object;
  scope: Record<string, unknown>;
}) {
  return await compileBrowserReplFunction(input.code)(input.itx, input.env ?? {}, input.scope);
}

export async function runBrowserReplEntry(input: {
  code: string;
  itx: unknown;
  env?: object;
  scope: Record<string, unknown>;
}): Promise<BrowserReplEntry> {
  const trimmedCode = input.code.trim();
  const consoleLogs: BrowserReplConsoleLog[] = [];
  const previousConsole = input.scope.console;
  input.scope.console = createBrowserReplConsole(consoleLogs);
  try {
    const result = await evalBrowserReplSessionCode({
      code: trimmedCode,
      itx: input.itx,
      env: input.env,
      scope: input.scope,
    });
    input.scope.$_ = result;
    input.scope._ = result;
    const formattedResult = formatBrowserReplResult(result);
    return {
      code: trimmedCode,
      consoleOutput: formatBrowserReplConsoleOutput(consoleLogs),
      output: formattedResult.text,
      outputLanguage: formattedResult.language,
      result,
      status: "success",
    };
  } catch (error) {
    return {
      code: trimmedCode,
      consoleOutput: formatBrowserReplConsoleOutput(consoleLogs),
      output: error instanceof Error ? (error.stack ?? error.message) : String(error),
      outputLanguage: "text",
      status: "error",
    };
  } finally {
    if (previousConsole === undefined) {
      delete input.scope.console;
    } else {
      input.scope.console = previousConsole;
    }
  }
}

export function compileBrowserReplFunction(rawCode: string) {
  const code = rewriteBrowserReplImports(rawCode);
  if (startsWithTopLevelDeclaration(code)) {
    return compileBrowserReplStatements(code);
  }

  const expressionSource = `return (async () => (${code}))()`;
  try {
    // oxlint-disable-next-line no-new-func -- This helper backs the explicit browser-local REPL.
    return new Function(
      "itx",
      "env",
      "scope",
      `with (scope) { ${expressionSource} }`,
    ) as ReplFunction;
  } catch {
    return compileBrowserReplStatements(code);
  }
}

type ReplFunction = (itx: unknown, env: object, scope: Record<string, unknown>) => Promise<unknown>;

const RESERVED_TOP_LEVEL_BINDINGS = new Set(["itx", "env", "scope", "console", "$_", "_"]);

function compileBrowserReplStatements(code: string) {
  const statementSource = transformTopLevelStatements(code);
  // The newlines around the user's source are load-bearing: if the snippet
  // ends in a line comment (`// ...`), an appended `; return …` on the same
  // line would be swallowed by that comment. The `\n` closes it first.
  // oxlint-disable-next-line no-new-func -- Statement-mode fallback for the explicit browser-local REPL.
  return new Function(
    "itx",
    "env",
    "scope",
    `with (scope) { return (async () => { let __replLastValue;\n${statementSource}\n; return __replLastValue })() }`,
  ) as ReplFunction;
}

function startsWithTopLevelDeclaration(code: string) {
  return /^\s*(?:async\s+function|function|class)\s+[A-Za-z_$][\w$]*/.test(code);
}

/**
 * Rewrite top-level `import` declarations into awaited dynamic imports so REPL
 * snippets can use npm packages: bare specifiers load from https://esm.sh,
 * full URLs load as-is, and each binding becomes a plain top-level `const`
 * (which the statement transform then persists onto the session scope, so an
 * import in one entry stays usable in the next). Scanning reuses the
 * top-level statement ranges, so `import` lines inside template-literal
 * worker sources are never touched. Relative and scheme'd specifiers (./x,
 * node:fs, cloudflare:workers) are left alone — they have no meaning in a
 * browser session and should fail loudly rather than silently load the wrong
 * thing.
 */
export function rewriteBrowserReplImports(code: string): string {
  const replacements: Array<{ end: number; start: number; text: string }> = [];
  let moduleIndex = 0;

  for (const range of readTopLevelStatementRanges(code)) {
    const statement = code.slice(range.start, range.end);
    if (!/^import\b/.test(statement)) continue;
    const text = rewriteImportStatement(statement, () => `__replModule${(moduleIndex += 1)}`);
    if (text === null) continue;
    // Statement ranges stop AT a terminating semicolon; consume it so the
    // rewritten statements don't leave a stray `;;` behind.
    const end = code[range.end] === ";" ? range.end + 1 : range.end;
    replacements.push({ end, start: range.start, text });
  }

  if (replacements.length === 0) return code;

  let transformed = code;
  for (const replacement of replacements.toReversed()) {
    transformed =
      transformed.slice(0, replacement.start) +
      replacement.text +
      transformed.slice(replacement.end);
  }

  return transformed;
}

/** The rewritten statement, "" to drop (type-only), or null to leave as-is. */
function rewriteImportStatement(statement: string, nextModuleVar: () => string): string | null {
  // Side-effect import: import "module"
  const sideEffect = /^import\s*(["'])([^"'\n]+)\1\s*;?$/.exec(statement);
  if (sideEffect) {
    const url = browserReplImportUrl(sideEffect[2]!);
    return url === null ? null : `await import(${JSON.stringify(url)})`;
  }

  const declaration = /^import\s+([\s\S]+?)\s+from\s*(["'])([^"'\n]+)\2\s*;?$/.exec(statement);
  if (!declaration) return null; // includes import(...) expressions — not declarations
  const url = browserReplImportUrl(declaration[3]!);
  if (url === null) return null;

  let clause = declaration[1]!.trim();
  if (/^type\b/.test(clause)) return ""; // type-only imports have no runtime effect

  const moduleVar = nextModuleVar();
  const statements = [`const ${moduleVar} = await import(${JSON.stringify(url)})`];

  // Default import: import d[, ...] from "module"
  if (!clause.startsWith("{") && !clause.startsWith("*")) {
    const defaultBinding = /^([A-Za-z_$][\w$]*)\s*(,\s*)?/.exec(clause);
    if (!defaultBinding) return null;
    statements.push(`const ${defaultBinding[1]} = ${moduleVar}.default`);
    clause = defaultBinding[2] ? clause.slice(defaultBinding[0].length) : "";
  }

  if (clause.startsWith("*")) {
    // Namespace import: * as ns
    const namespace = /^\*\s*as\s+([A-Za-z_$][\w$]*)$/.exec(clause);
    if (!namespace) return null;
    statements.push(`const ${namespace[1]} = ${moduleVar}`);
  } else if (clause.startsWith("{")) {
    // Named imports: { a, b as c, type T }
    if (!clause.endsWith("}")) return null;
    for (const rawItem of clause.slice(1, -1).split(",")) {
      const item = rawItem.trim();
      if (!item || /^type\b/.test(item)) continue;
      const renamed = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(item);
      if (renamed) statements.push(`const ${renamed[2]} = ${moduleVar}.${renamed[1]}`);
      else if (/^[A-Za-z_$][\w$]*$/.test(item))
        statements.push(`const ${item} = ${moduleVar}.${item}`);
      else return null; // string-named exports etc. — leave the import untouched
    }
  } else if (clause !== "") {
    return null;
  }

  return `${statements.join(";\n")};`;
}

function browserReplImportUrl(specifier: string): string | null {
  if (/^https?:\/\//.test(specifier)) return specifier;
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":"))
    return null;
  return `https://esm.sh/${specifier}`;
}

function transformTopLevelStatements(code: string) {
  const replacements: Array<{ end: number; start: number; text: string }> = [];

  let state:
    | "code"
    | "line-comment"
    | "block-comment"
    | "single-quote"
    | "double-quote"
    | "template" = "code";
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];

    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (char === "\\") index += 1;
      else if (char === "'") state = "code";
      continue;
    }
    if (state === "double-quote") {
      if (char === "\\") index += 1;
      else if (char === '"') state = "code";
      continue;
    }
    if (state === "template") {
      if (char === "\\") index += 1;
      else if (char === "`") state = "code";
      continue;
    }

    if (char === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char === "'") {
      state = "single-quote";
      continue;
    }
    if (char === '"') {
      state = "double-quote";
      continue;
    }
    if (char === "`") {
      state = "template";
      continue;
    }

    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);

    if (braceDepth !== 0 || bracketDepth !== 0 || parenDepth !== 0) continue;
    if (!isTopLevelStatementBoundary(code, index)) continue;

    const replacement = readTopLevelDeclarationReplacement(code, index);
    if (!replacement) continue;

    replacements.push(replacement);
    index = replacement.end - 1;
  }

  const finalExpressionReplacement = readFinalTopLevelExpressionReplacement(code);
  if (finalExpressionReplacement) replacements.push(finalExpressionReplacement);

  let transformed = code;
  for (const replacement of replacements.toReversed()) {
    transformed =
      transformed.slice(0, replacement.start) +
      replacement.text +
      transformed.slice(replacement.end);
  }

  return transformed;
}

function readFinalTopLevelExpressionReplacement(
  code: string,
): { end: number; start: number; text: string } | null {
  const ranges = readTopLevelStatementRanges(code);
  const finalRange = ranges.at(-1);
  if (!finalRange) return null;

  const statement = code.slice(finalRange.start, finalRange.end).trim();
  if (!statement) return null;
  if (!isTopLevelExpressionStatement(statement)) return null;

  return {
    start: finalRange.start,
    end: finalRange.end,
    text: `__replLastValue = ${code.slice(finalRange.start, finalRange.end)}`,
  };
}

function readTopLevelStatementRanges(code: string) {
  const ranges: Array<{ end: number; start: number }> = [];
  let statementStart: number | null = null;
  let state:
    | "code"
    | "line-comment"
    | "block-comment"
    | "single-quote"
    | "double-quote"
    | "template" = "code";
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];

    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (char === "\\") index += 1;
      else if (char === "'") state = "code";
      continue;
    }
    if (state === "double-quote") {
      if (char === "\\") index += 1;
      else if (char === '"') state = "code";
      continue;
    }
    if (state === "template") {
      if (char === "\\") index += 1;
      else if (char === "`") state = "code";
      continue;
    }

    if (char === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char === "'") {
      state = "single-quote";
      continue;
    }
    if (char === '"') {
      state = "double-quote";
      continue;
    }
    if (char === "`") {
      state = "template";
      continue;
    }

    if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      if (statementStart === null && !/\s/.test(char)) statementStart = index;

      if (statementStart !== null && char === ";") {
        ranges.push({ start: statementStart, end: index });
        statementStart = null;
      } else if (
        statementStart !== null &&
        (char === "\n" || char === "\r") &&
        canEndTopLevelStatementAtLineBreak(code, statementStart, index)
      ) {
        ranges.push({ start: statementStart, end: index });
        statementStart = null;
      }
    }

    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
  }

  if (statementStart !== null) {
    const end = trimEndIndex(code);
    if (end > statementStart) ranges.push({ start: statementStart, end });
  }

  return ranges;
}

function canEndTopLevelStatementAtLineBreak(code: string, start: number, end: number) {
  const statement = code.slice(start, end).trimEnd();
  if (!statement) return false;
  if (isLineBreakContinuation(code, end)) return false;
  return !/[([{:.,=?!+\-*/%&|^~<>]$/.test(statement);
}

function isLineBreakContinuation(code: string, index: number) {
  const next = nextNonWhitespaceCharacter(code, index);
  return next !== null && LINE_BREAK_CONTINUATION_STARTS.has(next);
}

const LINE_BREAK_CONTINUATION_STARTS = new Set([
  "%",
  "&",
  "(",
  "*",
  "+",
  "-",
  ".",
  "/",
  ":",
  "<",
  "=",
  ">",
  "?",
  "[",
  "^",
  "`",
  "|",
]);

function nextNonWhitespaceCharacter(code: string, index: number) {
  for (let nextIndex = index + 1; nextIndex < code.length; nextIndex += 1) {
    const char = code[nextIndex];
    if (char && !/\s/.test(char)) return char;
  }

  return null;
}

function trimEndIndex(code: string) {
  let end = code.length;
  while (end > 0 && /\s/.test(code[end - 1] ?? "")) end -= 1;
  if (code[end - 1] === ";") end -= 1;
  while (end > 0 && /\s/.test(code[end - 1] ?? "")) end -= 1;
  return end;
}

function isTopLevelExpressionStatement(statement: string) {
  return !/^(?:async\s+function|break|class|const|continue|debugger|do|export|for|function|if|import|let|return|switch|throw|try|var|while|with)\b/.test(
    statement,
  );
}

function readTopLevelDeclarationReplacement(
  code: string,
  index: number,
): { end: number; start: number; text: string } | null {
  const source = code.slice(index);
  const variable = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(source);
  if (variable?.[1]) {
    const equalsIndex = index + variable[0].length - 1;
    return {
      start: index,
      end: equalsIndex,
      text: `__replLastValue = ${scopeAssignmentTarget(variable[1])} `,
    };
  }

  const asyncFunction = /^async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(source);
  if (asyncFunction?.[1]) {
    const parenIndex = index + asyncFunction[0].length - 1;
    return {
      start: index,
      end: parenIndex,
      text: `__replLastValue = ${scopeAssignmentTarget(asyncFunction[1])} = async function ${asyncFunction[1]}`,
    };
  }

  const namedFunction = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(source);
  if (namedFunction?.[1]) {
    const parenIndex = index + namedFunction[0].length - 1;
    return {
      start: index,
      end: parenIndex,
      text: `__replLastValue = ${scopeAssignmentTarget(namedFunction[1])} = function ${namedFunction[1]}`,
    };
  }

  const namedClass = /^class\s+([A-Za-z_$][\w$]*)\b/.exec(source);
  if (namedClass?.[1]) {
    return {
      start: index,
      end: index + namedClass[0].length,
      text: `__replLastValue = ${scopeAssignmentTarget(namedClass[1])} = class ${namedClass[1]}`,
    };
  }

  return null;
}

function isTopLevelStatementBoundary(code: string, index: number) {
  if (!isIdentifierStart(code[index] ?? "")) return false;

  let previous = index - 1;
  let crossedLineBreak = false;
  while (previous >= 0 && /\s/.test(code[previous] ?? "")) {
    crossedLineBreak ||= code[previous] === "\n" || code[previous] === "\r";
    previous -= 1;
  }
  if (previous < 0) return true;
  if (crossedLineBreak) return true;

  return [";", "}"].includes(code[previous] ?? "");
}

function isIdentifierStart(value: string) {
  return /^[A-Za-z_$]$/.test(value);
}

function scopeAssignmentTarget(name: string) {
  if (RESERVED_TOP_LEVEL_BINDINGS.has(name)) {
    throw new Error(`REPL binding ${JSON.stringify(name)} is reserved.`);
  }

  return `scope.${name}`;
}

export function formatBrowserReplResult(result: unknown): {
  language: "json" | "text";
  text: string;
} {
  if (result === undefined) return { language: "text", text: "undefined" };
  if (typeof result === "string") return { language: "text", text: result };
  if (typeof result === "function") return { language: "text", text: String(result) };
  try {
    const json = JSON.stringify(result, null, 2);
    if (json !== undefined) return { language: "json", text: json };
    return { language: "text", text: String(result) };
  } catch {
    return { language: "text", text: String(result) };
  }
}

type BrowserReplConsoleLog = {
  args: unknown[];
  method: BrowserReplConsoleMethod;
};

type BrowserReplConsoleMethod = "debug" | "error" | "info" | "log" | "table" | "warn";

function createBrowserReplConsole(logs: BrowserReplConsoleLog[]) {
  const capturedMethods = new Map<BrowserReplConsoleMethod, (...args: unknown[]) => void>();
  const capture = (method: BrowserReplConsoleMethod) => {
    return (...args: unknown[]) => {
      logs.push({ args, method });
    };
  };

  for (const method of BROWSER_REPL_CONSOLE_METHODS) {
    capturedMethods.set(method, capture(method));
  }

  return new Proxy(globalThis.console, {
    get(consoleTarget, key, receiver) {
      if (typeof key === "string" && isBrowserReplConsoleMethod(key)) {
        return capturedMethods.get(key);
      }

      const value = Reflect.get(consoleTarget, key, receiver);
      if (typeof value === "function") return value.bind(consoleTarget);
      return value;
    },
  });
}

const BROWSER_REPL_CONSOLE_METHODS = ["debug", "error", "info", "log", "table", "warn"] as const;

function isBrowserReplConsoleMethod(value: string): value is BrowserReplConsoleMethod {
  return BROWSER_REPL_CONSOLE_METHODS.includes(value as BrowserReplConsoleMethod);
}

function formatBrowserReplConsoleOutput(logs: BrowserReplConsoleLog[]) {
  return logs
    .map((log) => {
      const prefix = log.method === "log" ? "" : `${log.method}: `;
      return `${prefix}${log.args.map(formatBrowserReplConsoleArg).join(" ")}`;
    })
    .join("\n");
}

function formatBrowserReplConsoleArg(arg: unknown) {
  return formatBrowserReplResult(arg).text;
}
