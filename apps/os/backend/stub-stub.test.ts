import { AsyncLocalStorage } from "async_hooks";
import { expect, expectTypeOf, test } from "vitest";
import { stubStub, type WithCallMethod, callMethodImpl } from "./stub-stub.ts";

test("stubStub", async () => {
  const storage = new AsyncLocalStorage<Record<string, string>>();

  class MyClass implements WithCallMethod {
    callMethod(methodName: string, args: unknown[], context: Record<string, string>) {
      return storage.run(context, () => callMethodImpl(this, methodName, args));
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
        at callMethodImpl ({cwd}/backend/stub-stub.ts:28:78)
        at {cwd}/backend/stub-stub.test.ts:10:41
        at AsyncLocalStorage.run (node:internal/async_local_storage/async_context_frame:63:14)
        at MyClass.callMethod ({cwd}/backend/stub-stub.test.ts:10:22)
        at Proxy.<anonymous> ({cwd}/backend/stub-stub.ts:80:35)
        at {cwd}/backend/stub-stub.test.ts:33:16
        at processTicksAndRejections (node:internal/process/task_queues:105:5)
        at node_modules-blah-blah/@vitest/node_modules-more-blah-blah
        at Proxy.<anonymous> ({cwd}/backend/stub-stub.ts:79:29)
        at {cwd}/backend/stub-stub.test.ts:33:16
        at processTicksAndRejections (node:internal/process/task_queues:105:5)
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
    // .replaceAll(/:\d+:\d+\b/g, "")
    .replaceAll(
      new RegExp(`${import.meta.filename}:(\\d+):(\\d+)\\b`, "g"),
      () => `${import.meta.filename.split("/").pop()!}:{line}:{column}`,
    );
