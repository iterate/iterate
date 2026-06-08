export const DEFAULT_BROWSER_REPL_CODE = "await ctx.projects.list({ limit: 5 })";

export async function evalBrowserReplCode(input: { code: string; ctx: unknown; env?: object }) {
  return await compileBrowserReplFunction(input.code)(input.ctx, input.env ?? {});
}

export function compileBrowserReplFunction(code: string) {
  try {
    // oxlint-disable-next-line no-new-func -- This helper backs the explicit browser-local REPL.
    return new Function("ctx", "env", `return (async () => (${code}))()`) as ReplFunction;
  } catch {
    // oxlint-disable-next-line no-new-func -- Statement-mode fallback for the explicit browser-local REPL.
    return new Function("ctx", "env", `return (async () => {${code}})()`) as ReplFunction;
  }
}

type ReplFunction = (ctx: unknown, env: object) => Promise<unknown>;

export function formatBrowserReplResult(result: unknown) {
  if (result === undefined) return "undefined";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
