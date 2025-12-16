import { AsyncLocalStorage } from "async_hooks";
import { expect, expectTypeOf, test, vi } from "vitest";
import { stubStub } from "./stub-stub.ts";

test("stubStub", async () => {
  const storage = new AsyncLocalStorage<Record<string, string>>();

  class MyClass implements stubStub.Callable {
    callMethod(params: stubStub.CallMethodParams) {
      return storage.run(params.context, () => stubStub.callMethodImpl(this, params));
    }

    async getGreeting({ language }: { language: "en" | "fr" }) {
      if (language === "en") return "Hello";
      if (language === "fr") return "Bonjour";

      throw new Error("Invalid language. Context: " + JSON.stringify(storage.getStore()));
    }
  }

  const raw = new MyClass();
  const stub = stubStub(raw, { requestId: "abc123" });

  await expect(stub.getGreeting({ language: "en" })).resolves.toBe("Hello");
  await expect(stub.getGreeting({ language: "fr" })).resolves.toBe("Bonjour");

  expectTypeOf(stub.getGreeting).returns.toEqualTypeOf<Promise<"Hello" | "Bonjour">>();

  await expect(stub.getGreeting({ language: "de" as never })).rejects.toThrow(
    'Invalid language. Context: {"requestId":"abc123"}',
  );
  expect(
    await stub.getGreeting({ language: "de" as never }).catch((e) => simplifyCallStack(e.stack)),
  ).toMatchInlineSnapshot(`
    "Error: Invalid language. Context: {"requestId":"abc123"}
        at MyClass.getGreeting ({cwd}/backend/stub-stub.test.ts:17:13)
        at stubStub.callMethodImpl ({cwd}/backend/stub-stub.ts:107:47)
        at {cwd}/backend/stub-stub.test.ts:10:57
        at AsyncLocalStorage.run (node:internal/...)
        at MyClass.callMethod ({cwd}/backend/stub-stub.test.ts:10:22)
        at Proxy.<anonymous> ({cwd}/backend/stub-stub.ts:41:35)
        at {cwd}/backend/stub-stub.test.ts:33:16
        at processTicksAndRejections (node:internal/...)
        at node_modules-blah-blah/@vitest/node_modules-more-blah-blah
        at Proxy.<anonymous> ({cwd}/backend/stub-stub.ts:39:29)
        at {cwd}/backend/stub-stub.test.ts:33:16
        at processTicksAndRejections (node:internal/...)
        at node_modules-blah-blah/@vitest/node_modules-more-blah-blah"
  `);
});

test("stubStub passes caller stack", async () => {
  const mockLog = vi.fn();
  const storage = new AsyncLocalStorage<{ context: Record<string, string>; callerStack: string }>();

  class MyClass implements stubStub.Callable {
    callMethod(params: stubStub.CallMethodParams) {
      return storage.run({ context: params.context, callerStack: params.callerStack }, () =>
        stubStub.callMethodImpl(this, params),
      );
    }

    async getGreeting({ language }: { language: "en" | "fr" }) {
      if (language === "en") return "Hello";
      if (language === "fr") return "Bonjour";

      mockLog(new Error("Invalid language. Context: " + JSON.stringify(storage.getStore())));
      return null;
    }
  }

  const raw = new MyClass();
  const stub = stubStub(raw, { requestId: "abc123" });

  await expect(stub.getGreeting({ language: "en" })).resolves.toBe("Hello");
  await expect(stub.getGreeting({ language: "fr" })).resolves.toBe("Bonjour");

  expectTypeOf(stub.getGreeting).returns.toEqualTypeOf<Promise<"Hello" | "Bonjour" | null>>();

  await expect(stub.getGreeting({ language: "de" as never })).resolves.toBeNull();
  expect(mockLog).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringMatching(/Invalid language. Context: {.*}/) }),
  );
  const call = mockLog.mock.calls[0][0] as Error;
  const { callerStack } = JSON.parse(call.message.slice(call.message.indexOf("{")));
  expect(simplifyCallStack(callerStack)).toMatchInlineSnapshot(`
    "    at Proxy.<anonymous> ({cwd}/backend/stub-stub.ts:39:29)
        at {cwd}/backend/stub-stub.test.ts:80:21
        at processTicksAndRejections (node:internal/...)
        at node_modules-blah-blah/@vitest/node_modules-more-blah-blah"
  `);
  expect(simplifyCallStack(call.stack!.replace(/Context: {.*}/, "Context: {***}")))
    .toMatchInlineSnapshot(`
      "Error: Invalid language. Context: {***}
          at MyClass.getGreeting ({cwd}/backend/stub-stub.test.ts:67:15)
          at stubStub.callMethodImpl ({cwd}/backend/stub-stub.ts:107:47)
          at {cwd}/backend/stub-stub.test.ts:59:18
          at AsyncLocalStorage.run (node:internal/...)
          at MyClass.callMethod ({cwd}/backend/stub-stub.test.ts:58:22)
          at Proxy.<anonymous> ({cwd}/backend/stub-stub.ts:41:35)
          at {cwd}/backend/stub-stub.test.ts:80:21
          at processTicksAndRejections (node:internal/...)
          at node_modules-blah-blah/@vitest/node_modules-more-blah-blah"
    `);
});

const simplifyCallStack = (stack: string) =>
  stack
    .replaceAll(process.cwd(), "{cwd}")
    .replaceAll(
      /file:\/\/\/.*node_modules\/([^/]+)\/.*:\d+:\d+\b/g,
      "node_modules-blah-blah/$1/node_modules-more-blah-blah",
    )
    .replaceAll(/\(node:internal.*\)/g, "(node:internal/...)")
    .replaceAll(
      new RegExp(`${import.meta.filename}:(\\d+):(\\d+)\\b`, "g"),
      () => `${import.meta.filename.split("/").pop()!}:{line}:{column}`,
    );
