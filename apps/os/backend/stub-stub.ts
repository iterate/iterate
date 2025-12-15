export interface WithCallMethod {
  callMethod(
    methodName: string,
    args: unknown[],
    context: Record<string, string>,
  ): Promise<
    | { ok: true; result: unknown; error?: never }
    | { ok: false; result?: never; error: { message: string; stack: string } }
  >;
}

/**
 * Recommended implementation of `callMethod` for stub-able classes. Will catch and wrap errors to allow call stacks to cross boundaries. Use like this (in this example using a logger called `myLogger`):
 * ```ts
 * class MyClass implements WithCallMethod {
 *   callMethod(methodName: string, args: unknown[], context: Record<string, string>) {
 *     return myLogger.run(context, () => callMethodImpl(this, methodName, args));
 *   }
 * }
 * ```
 */
export async function callMethodImpl<T extends WithCallMethod>(
  _this: T,
  methodName: string,
  args: unknown[],
): ReturnType<WithCallMethod["callMethod"]> {
  try {
    const result = await (_this as {} as Record<string, Function>)[methodName](...args);
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: { message: String(error), stack: (error as Error).stack || "" } };
  }
}

export type StubStub<T extends WithCallMethod> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/**
 * Wraps an object conforming to @see WithCallMethod in a proxy stub which replaces method calls with `.callMethod(...)`.
 *
 * @example
 * class MyCalculator implements WithCallMethod {
 *   callMethod(methodName, args, context) {
 *     // assuming a logger which uses async_hooks to manage context
 *     return logger.run(context, () => this[methodName](...args));
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
export const stubStub = <Stub extends WithCallMethod>(
  stub: Stub,
  context: Record<string, string>,
): StubStub<Stub> & { raw: Stub } => {
  return new Proxy({} as StubStub<Stub> & { raw: Stub }, {
    get: (_target, prop) => {
      if (prop === "raw") return stub;
      if (prop === "fetch" || prop === "then") {
        const value = stub[prop as keyof Stub];
        return typeof value === "function" ? value.bind(stub) : value;
      }
      return async (...args: any[]) => {
        const callerStack = Error().stack?.split("\n").slice(1).join("\n");
        const result = await stub.callMethod(prop as string, args, context);
        if (result.ok) {
          return result.result;
        }
        const { message, stack } = result.error;
        const error = new Error(
          `${message} (in stubStub ${String(prop)} call, raw error in 'cause')`,
          { cause: result.error },
        );

        error.stack = stack;
        if (callerStack && !stack.includes(callerStack)) {
          error.stack += `\n${callerStack}`;
        }

        throw error;
      };
    },
  });
};
