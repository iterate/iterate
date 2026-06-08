export const DEFAULT_BROWSER_REPL_CODE = "await ctx.projects.list({ limit: 5 })";

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
    const statementSource = transformTopLevelDeclarations(code);
    // oxlint-disable-next-line no-new-func -- Statement-mode fallback for the explicit browser-local REPL.
    return new Function(
      "ctx",
      "env",
      "scope",
      `with (scope) { return (async () => {${statementSource}})() }`,
    ) as ReplFunction;
  }
}

type ReplFunction = (ctx: unknown, env: object, scope: Record<string, unknown>) => Promise<unknown>;

function transformTopLevelDeclarations(code: string) {
  return code
    .replace(/(^|[;\n]\s*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g, "$1scope.$2 =")
    .replace(/(^|[;\n]\s*)function\s+([A-Za-z_$][\w$]*)\s*\(/g, "$1scope.$2 = function (")
    .replace(/(^|[;\n]\s*)class\s+([A-Za-z_$][\w$]*)\b/g, "$1scope.$2 = class $2");
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
