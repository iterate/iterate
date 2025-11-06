export interface WithCallMethod {
  callMethod(
    methodName: string,
    args: unknown[],
    context: Record<string, string>,
  ): Promise<unknown>;
}

export type StubStub<T extends WithCallMethod> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never;
};

/**
 * Wraps an object conforming to @see WithCallMethod in a proxy stub which replaces method calls with `.callMethod(...)`.
 *
 * @example
 * class MyCalculator implements WithCallMethod {
 *   callMethod(methodName», args, context) {
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
      // @ts-expect-error trust me bro
      if (prop === "fetch" || prop === "then") return stub[prop].bind(stub);
      return (...args: any[]) => stub.callMethod(prop as string, args, context);
    },
  });
};
