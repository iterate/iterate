export type CodemodeSessionCapability = {
  callFunction(input: {
    functionCallId?: string;
    input: unknown;
    path: string[];
    scriptExecutionId?: string;
  }): Promise<unknown>;
};

export type CreateCodemodeContextOptions = {
  abortSignal?: AbortSignal;
  codemodeSessionCapability: CodemodeSessionCapability;
  scriptExecutionId?: string;
};

/**
 * Build the object that user scripts and provider implementations receive.
 *
 * This helper intentionally depends only on a narrow Codemode Session Capability.
 * It can be copied into Dynamic Worker source, or imported by ordinary provider
 * code, without knowing whether that capability is a local object, a Durable
 * Object RPC target, or a Worker RPC target returned by another method.
 */
export function createCodemodeContext(options: CreateCodemodeContextOptions) {
  return createPathProxy([], options) as unknown as CodemodeContext;
}

export type CodemodeContext = {
  readonly abortSignal: AbortSignal | undefined;
} & Record<string, ToolFunctionProxy>;

export interface ToolFunctionProxy {
  (payload?: unknown): Promise<unknown>;
  [key: string]: ToolFunctionProxy;
}

function createPathProxy(path: string[], options: CreateCodemodeContextOptions): ToolFunctionProxy {
  return new Proxy(async () => undefined, {
    get(_target, key) {
      // Promise utilities probe `then`/`catch`/`finally` to detect thenables.
      // Tool provider paths are arbitrary, so returning a nested proxy here
      // would turn promise introspection into accidental tool calls.
      if (key === "then" || key === "catch" || key === "finally") return undefined;
      if (key === "abortSignal" && path.length === 0) return options.abortSignal;
      if (typeof key !== "string") return undefined;

      return createPathProxy([...path, key], options);
    },
    async apply(_target, _thisArg, args) {
      return await options.codemodeSessionCapability.callFunction({
        input: args[0],
        path,
        scriptExecutionId: options.scriptExecutionId,
      });
    },
  }) as ToolFunctionProxy;
}
