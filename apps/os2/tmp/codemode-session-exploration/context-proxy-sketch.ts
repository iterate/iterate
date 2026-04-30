/**
 * Shared CodemodeContext proxy sketch.
 *
 * The runtime helper should be tiny enough to copy into dynamic worker source.
 * Provider implementations can import a real helper; generated dynamic workers
 * get the equivalent source inlined.
 */

type ToolFunctionCall = {
  path: string[];
  payload: unknown;
  scriptExecutionRequestedOffset?: number;
};

type CodemodeSessionCapability = {
  callToolFunction(call: ToolFunctionCall): Promise<unknown>;
  append(input: { type: string; payload?: object; metadata?: object }): Promise<unknown>;
  getStreamPath(): Promise<string>;
  executeScript(input: { code: string }): Promise<unknown>;
};

type CodemodeContextOptions = {
  scriptExecutionRequestedOffset?: number;
  abortSignal?: AbortSignal;
};

const NON_TOOL_PROMISE_KEYS = new Set(["then", "catch", "finally"]);

export function createCodemodeContext(
  capability: CodemodeSessionCapability,
  options: CodemodeContextOptions = {},
) {
  const toolFunctions = createToolFunctionProxy(async (path, payload) => {
    return await capability.callToolFunction({
      path,
      payload,
      scriptExecutionRequestedOffset: options.scriptExecutionRequestedOffset,
    });
  });

  const codemode = {
    append: (input: Parameters<CodemodeSessionCapability["append"]>[0]) => capability.append(input),
    getStreamPath: () => capability.getStreamPath(),
    executeScript: (input: { code: string }) => capability.executeScript(input),
    abortSignal: options.abortSignal ?? new AbortController().signal,
  };

  return new Proxy(toolFunctions, {
    get(target, key, receiver) {
      if (key === "codemode") return codemode;
      return Reflect.get(target, key, receiver);
    },
  });
}

function createToolFunctionProxy(
  call: (path: string[], payload: unknown) => Promise<unknown>,
  path: string[] = [],
): unknown {
  return new Proxy(async () => {}, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      if (NON_TOOL_PROMISE_KEYS.has(key)) return undefined;
      return createToolFunctionProxy(call, [...path, key]);
    },
    async apply(_target, _thisArg, args) {
      return await call(path, args[0] ?? {});
    },
  });
}

export function createCodemodeContextSource() {
  return `
function __createCodemodeContext(capability, options = {}) {
  const make = (path = []) => new Proxy(async () => {}, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      if (key === "then" || key === "catch" || key === "finally") return undefined;
      return make([...path, key]);
    },
    async apply(_target, _thisArg, args) {
      return await capability.callToolFunction({
        path,
        payload: args[0] ?? {},
        scriptExecutionRequestedOffset: options.scriptExecutionRequestedOffset,
      });
    },
  });

  const toolFunctions = make();
  const codemode = {
    append: async (input) => await capability.append(input),
    getStreamPath: async () => await capability.getStreamPath(),
    executeScript: async (input) => await capability.executeScript(input),
    abortSignal: options.abortSignal ?? new AbortController().signal,
  };

  return new Proxy(toolFunctions, {
    get(target, key, receiver) {
      if (key === "codemode") return codemode;
      return Reflect.get(target, key, receiver);
    },
  });
}`;
}

/**
 * Leaf providers work naturally: if a provider is registered at path ["search"],
 * the call ctx.search({ q: "..." }) arrives as full path ["search"]. Session
 * dispatch resolves the longest registered provider prefix, leaving [] as the
 * provider-local tool path.
 */
export const leafProviderExample = `
async (ctx) => {
  const searchResult = await ctx.search({ q: "codemode" });
  await ctx.codemode.append({
    type: "events.iterate.com/codemode/log-emitted",
    payload: { message: "search complete" },
  });
  return searchResult;
}`;
