export const DEFAULT_BROWSER_REPL_CODE = "await ctx.projects.list({ limit: 5 })";

export type BrowserReplExample = {
  code: string;
  description: string;
  id: string;
  title: string;
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
  return code
    .replace(
      /(^|[;\n]\s*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
      (_match, prefix: string, name: string) => `${prefix}${scopeAssignmentTarget(name)} =`,
    )
    .replace(
      /(^|[;\n]\s*)async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g,
      (_match, prefix: string, name: string) =>
        `${prefix}${scopeAssignmentTarget(name)} = async function ${name}(`,
    )
    .replace(
      /(^|[;\n]\s*)function\s+([A-Za-z_$][\w$]*)\s*\(/g,
      (_match, prefix: string, name: string) =>
        `${prefix}${scopeAssignmentTarget(name)} = function ${name}(`,
    )
    .replace(
      /(^|[;\n]\s*)class\s+([A-Za-z_$][\w$]*)\b/g,
      (_match, prefix: string, name: string) =>
        `${prefix}${scopeAssignmentTarget(name)} = class ${name}`,
    );
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
