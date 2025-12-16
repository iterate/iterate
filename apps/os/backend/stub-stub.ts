/**
 * Wraps an object conforming to @see WithCallMethod in a proxy stub which replaces method calls with `.callMethod(...)`.
 *
 * @example
 * class MyCalculator implements stubStub.Callable {
 *   callMethod(params: stubStub.CallMethodParams) {
 *     // assuming a logger which uses async_hooks to manage context
 *     return logger.run(context, () => stubStub.callMethodImpl(this, params));
 *   }
 *
 *   add(a: number, b: number) {
 *     logger.info("adding", { a, b });
 *     return a + b;
 *   }
 *
 *   subtract(a: number, b: number) {
 *     return a - b;
 *   }
 * }
 *
 * const myClass = new MyCalculator();
 * myClass.add(1, 2); // returns 3, logs "adding 1 + 2"
 *
 * const stub = stubStub(myClass, { className: "MyClass" });
 * stub.add(1, 2); // returns 3, logs "adding 1 + 2 {context: { className: 'MyClass' }}"
 */
export function stubStub<Stub extends stubStub.Callable>(
  stub: Stub,
  context: Record<string, string>,
): stubStub.StubStub<Stub> & { raw: Stub } {
  return new Proxy({} as stubStub.StubStub<Stub> & { raw: Stub }, {
    get: (_target, prop) => {
      if (prop === "raw") return stub;
      if (prop === "fetch" || prop === "then") {
        const value = stub[prop as keyof Stub];
        return typeof value === "function" ? value.bind(stub) : value;
      }
      return async (...args: any[]) => {
        const callerStack = Error().stack?.split("\n").slice(1).join("\n") || "";
        const method = prop as string;
        const result = await stub.callMethod({ method, args, context, callerStack });
        if (result.ok) {
          return result.result;
        }
        const { message, stack } = result.error;
        const error = new Error(
          `${message} (in stubStub ${String(prop)} call, raw error in 'cause')`,
          { cause: result.error },
        );

        error.stack = stack;
        if (!stack.includes(callerStack)) {
          error.stack += `\n${callerStack}`;
        }

        throw error;
      };
    },
  });
}

export namespace stubStub {
  export type CallMethodParams = {
    /** The name of the method the target should call */
    method: string;
    /** Arguments to pass to @see method */
    args: unknown[];
    /** Arbitrary string context/tags. This might look like `{ requestId: "abc123", appStage: "prod" }` or similar */
    context: Record<string, string>;
    /** A stack trace captured at the point of the call. This can be used to append to errors thrown in the target, in cases when the call crosses a boundary that loses call stacks. */
    callerStack: string;
  };

  /** The expected return type of @see CallMethod - which is expected *not* to throw errors, so that call stacks can be preserved across boundaries */
  export type CallMethodResult =
    | { ok: true; result: unknown; error?: never }
    | { ok: false; result?: never; error: { message: string; stack: string } };

  export type CallMethod = (params: CallMethodParams) => Promise<CallMethodResult>;

  export interface Callable {
    callMethod: CallMethod;
  }

  export type StubStub<T extends Callable> = {
    [K in keyof T]: T[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<Awaited<R>>
      : never;
  };

  /**
   * Recommended implementation of `callMethod` for stub-able classes. Will catch and wrap errors to allow call stacks to cross boundaries. Use like this (in this example using a logger called `myLogger`):
   * ```ts
   * class MyClass implements stubStub.Callable {
   *   callMethod(params: stubStub.CallMethodParams) {
   *     return myLogger.run(params.context, () => stubStub.callMethodImpl(this, params));
   *   }
   * }
   * ```
   */
  export async function callMethodImpl<T extends Callable>(
    callable: T,
    params: Pick<CallMethodParams, "method" | "args">,
  ): ReturnType<CallMethod> {
    try {
      const _this = callable as {} as Record<string, Function>;
      const result = await _this[params.method](...params.args);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: { message: String(error), stack: (error as Error).stack || "" } };
    }
  }
}
