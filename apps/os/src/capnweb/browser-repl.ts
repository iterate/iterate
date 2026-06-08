export const DEFAULT_BROWSER_REPL_CODE = "await ctx.projects.list({ limit: 5 })";

export type BrowserReplExample = {
  code: string;
  description: string;
  id: string;
  title: string;
};

export type BrowserReplEntry = {
  code: string;
  output: string;
  status: "error" | "success";
};

// These are intentionally ordinary REPL snippets for now. They should
// eventually become living tests: the actual e2e test snippets appear here, and
// this replaces codemode snippets entirely.
export const BROWSER_REPL_EXAMPLES: BrowserReplExample[] = [
  {
    id: "provide-alert-capability",
    title: "Provide and call a project capability",
    description:
      "Registers a browser-owned RpcTarget with a project, then immediately calls it back through ctx.projects.get(...).connections.",
    code: `
const projectPage = await ctx.projects.list({ limit: 1 });
const selectedProjectId =
  typeof projectId === "string" ? projectId : projectPage.projects[0]?.id;
if (!selectedProjectId) throw new Error("Create a project before running this snippet.");
const project = ctx.projects.get(selectedProjectId);

class AnswerCapability extends RpcTarget {
  async run() {
    alert("The answer is 42");
    return "alerted";
  }
}

await project.provideCapability({
  connectionKey: "answer",
  rpcTarget: new AnswerCapability(),
});

return await project.connections.get("answer").run();
`.trim(),
  },
];

export async function evalBrowserReplCode(input: { code: string; ctx: unknown; env?: object }) {
  return await compileBrowserReplFunction(input.code)(input.ctx, input.env ?? {}, {});
}

export async function evalBrowserReplSessionCode(input: {
  code: string;
  ctx: unknown;
  env?: object;
  scope: Record<string, unknown>;
}) {
  return await compileBrowserReplFunction(input.code)(input.ctx, input.env ?? {}, input.scope);
}

export async function runBrowserReplEntry(input: {
  code: string;
  ctx: unknown;
  env?: object;
  scope: Record<string, unknown>;
}): Promise<BrowserReplEntry> {
  const trimmedCode = input.code.trim();
  try {
    const result = await evalBrowserReplSessionCode({
      code: trimmedCode,
      ctx: input.ctx,
      env: input.env,
      scope: input.scope,
    });
    return {
      code: trimmedCode,
      output: formatBrowserReplResult(result),
      status: "success",
    };
  } catch (error) {
    return {
      code: trimmedCode,
      output: error instanceof Error ? (error.stack ?? error.message) : String(error),
      status: "error",
    };
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
      "ctx",
      "env",
      "scope",
      `with (scope) { ${expressionSource} }`,
    ) as ReplFunction;
  } catch {
    return compileBrowserReplStatements(code);
  }
}

type ReplFunction = (ctx: unknown, env: object, scope: Record<string, unknown>) => Promise<unknown>;

const RESERVED_TOP_LEVEL_BINDINGS = new Set(["ctx", "env", "scope"]);

function compileBrowserReplStatements(code: string) {
  const statementSource = transformTopLevelDeclarations(code);
  // oxlint-disable-next-line no-new-func -- Statement-mode fallback for the explicit browser-local REPL.
  return new Function(
    "ctx",
    "env",
    "scope",
    `with (scope) { return (async () => {${statementSource}})() }`,
  ) as ReplFunction;
}

function startsWithTopLevelDeclaration(code: string) {
  return /^\s*(?:async\s+function|function|class)\s+[A-Za-z_$][\w$]*/.test(code);
}

function transformTopLevelDeclarations(code: string) {
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

  let transformed = code;
  for (const replacement of replacements.toReversed()) {
    transformed =
      transformed.slice(0, replacement.start) +
      replacement.text +
      transformed.slice(replacement.end);
  }

  return transformed;
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
      text: `${scopeAssignmentTarget(variable[1])} `,
    };
  }

  const asyncFunction = /^async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(source);
  if (asyncFunction?.[1]) {
    const parenIndex = index + asyncFunction[0].length - 1;
    return {
      start: index,
      end: parenIndex,
      text: `${scopeAssignmentTarget(asyncFunction[1])} = async function ${asyncFunction[1]}`,
    };
  }

  const namedFunction = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(source);
  if (namedFunction?.[1]) {
    const parenIndex = index + namedFunction[0].length - 1;
    return {
      start: index,
      end: parenIndex,
      text: `${scopeAssignmentTarget(namedFunction[1])} = function ${namedFunction[1]}`,
    };
  }

  const namedClass = /^class\s+([A-Za-z_$][\w$]*)\b/.exec(source);
  if (namedClass?.[1]) {
    return {
      start: index,
      end: index + namedClass[0].length,
      text: `${scopeAssignmentTarget(namedClass[1])} = class ${namedClass[1]}`,
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

export function formatBrowserReplResult(result: unknown) {
  if (result === undefined) return "undefined";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
