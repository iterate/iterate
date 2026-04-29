type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
type JSONObject = { [key: string]: JSONValue };

export type CodemodeStreamPath = string;
export type CodemodeEventInput = {
  type: string;
  payload?: object;
  metadata?: JSONObject;
  idempotencyKey?: string;
  offset?: number;
};
export type CodemodeAppendedEvent = CodemodeEventInput & {
  createdAt: string;
  offset: number;
  streamPath: CodemodeStreamPath;
};

export type CodemodeSessionCapability = {
  append(input: CodemodeEventInput): Promise<CodemodeAppendedEvent>;
  callToolFunction(input: {
    path: string[];
    payload: unknown;
    scriptExecutionRequestedOffset?: number;
  }): Promise<unknown>;
  executeScript(input: { code: string }): Promise<CodemodeAppendedEvent>;
  getStreamPath(): Promise<CodemodeStreamPath>;
};

export type CreateCodemodeContextOptions = {
  abortSignal?: AbortSignal;
  codemodeSessionCapability: CodemodeSessionCapability;
  scriptExecutionRequestedOffset?: number;
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
  codemode: {
    readonly abortSignal: AbortSignal | undefined;
    append(input: CodemodeEventInput): Promise<CodemodeAppendedEvent>;
    executeScript(input: { code: string }): Promise<CodemodeAppendedEvent>;
    getStreamPath(): Promise<CodemodeStreamPath>;
  };
} & Record<string, ToolFunctionProxy>;

export interface ToolFunctionProxy {
  (payload?: unknown): Promise<unknown>;
  [key: string]: ToolFunctionProxy;
}

function createPathProxy(path: string[], options: CreateCodemodeContextOptions): ToolFunctionProxy {
  return new Proxy(async () => undefined, {
    get(_target, key) {
      if (key === "then") return undefined;
      if (key === "codemode" && path.length === 0) {
        return createCodemodeControlSurface(options);
      }
      if (typeof key !== "string") return undefined;

      return createPathProxy([...path, key], options);
    },
    async apply(_target, _thisArg, args) {
      return await options.codemodeSessionCapability.callToolFunction({
        path,
        payload: args[0],
        scriptExecutionRequestedOffset: options.scriptExecutionRequestedOffset,
      });
    },
  }) as ToolFunctionProxy;
}

function createCodemodeControlSurface(options: CreateCodemodeContextOptions) {
  return {
    get abortSignal() {
      return options.abortSignal;
    },
    append: (input: CodemodeEventInput) => options.codemodeSessionCapability.append(input),
    executeScript: (input: { code: string }) =>
      options.codemodeSessionCapability.executeScript(input),
    getStreamPath: () => options.codemodeSessionCapability.getStreamPath(),
  };
}
