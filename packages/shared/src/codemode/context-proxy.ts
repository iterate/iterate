export type CodemodeSessionCapability = {
  callFunction(input: {
    args: unknown[];
    functionCallId?: string;
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
  (...args: unknown[]): Promise<unknown>;
  [key: string]: ToolFunctionProxy;
}

function createPathProxy(path: string[], options: CreateCodemodeContextOptions): ToolFunctionProxy {
  // This is the original local codemode path recorder. It is intentionally a
  // Proxy because tool names are not known when the script is authored: the
  // user can write ctx.workspace.git.status(), ctx.project.deploy(), or any
  // provider-defined nested path, and each property read extends the recorded
  // path without requiring us to generate a TypeScript/JavaScript object tree.
  //
  // Effect:
  //   ctx.workspace.git.status("--short")
  // records:
  //   { path: ["workspace", "git", "status"], args: ["--short"] }
  // and forwards that to the Codemode Session capability's callFunction(...).
  //
  // This is not a Workers RPC or Cap'n Web remote stub; it is the older
  // in-process codemode equivalent of the same ergonomic idea. The newer
  // Cap'n Web path uses real RpcTarget/WorkerEntrypoint stubs where possible,
  // and only uses local proxies for unknown dynamic SDK paths. The important
  // semantic match is that arbitrary property chains are captured lazily and
  // invoked only when the final function call happens.
  //
  // References for the RPC/stub model this mirrors:
  // - Workers RPC docs: https://developers.cloudflare.com/workers/runtime-apis/rpc/
  // - Cap'n Web README: https://github.com/cloudflare/capnweb
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
    apply(_target, _thisArg, args) {
      return options.codemodeSessionCapability.callFunction({
        args,
        path,
        scriptExecutionId: options.scriptExecutionId,
      });
    },
  }) as ToolFunctionProxy;
}
