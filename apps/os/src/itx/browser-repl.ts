export const DEFAULT_BROWSER_REPL_CODE = "await itx.projects.list({ limit: 5 })";

export type BrowserReplExample = {
  code: string;
  description: string;
  id: string;
  title: string;
};

export type BrowserReplEntry = {
  code: string;
  consoleOutput: string;
  output: string;
  outputLanguage: "json" | "text";
  status: "error" | "success";
};

// These are intentionally ordinary REPL snippets for now. They should
// eventually become living tests: the actual e2e test snippets appear here, and
// this replaces codemode snippets entirely.
export const BROWSER_REPL_EXAMPLES: BrowserReplExample[] = [
  {
    id: "provide-alert-capability",
    title: "Provide and call a live capability",
    description:
      "Registers a browser-owned RpcTarget as a live capability on a project, then calls it back through the itx fallthrough — itx.answer.run().",
    code: `
const projectPage = await itx.projects.list({ limit: 1 });
const selectedProjectId =
  typeof projectId === "string" ? projectId : projectPage.projects[0]?.id;
if (!selectedProjectId) throw new Error("Create a project before running this snippet.");
const project = await itx.projects.get(selectedProjectId);

class AnswerCapability extends RpcTarget {
  async run() {
    alert("The answer is 42");
    return "alerted";
  }
}

await project.caps.provide({ name: "answer", target: new AnswerCapability() });

return await project.answer.run();
`.trim(),
  },
];

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

export function compileBrowserReplFunction(code: string) {
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
  // oxlint-disable-next-line no-new-func -- Statement-mode fallback for the explicit browser-local REPL.
  return new Function(
    "itx",
    "env",
    "scope",
    `with (scope) { return (async () => { let __replLastValue; ${statementSource}; return __replLastValue })() }`,
  ) as ReplFunction;
}

function startsWithTopLevelDeclaration(code: string) {
  return /^\s*(?:async\s+function|function|class)\s+[A-Za-z_$][\w$]*/.test(code);
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
