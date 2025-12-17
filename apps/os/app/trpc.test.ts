import { test, expect } from "vitest";
import { initTRPC, TRPCError } from "@trpc/server";
import { createHTTPServer } from "@trpc/server/adapters/standalone";
import { createTRPCClient, httpLink } from "@trpc/client";

async function setupTrpc() {
  const t = initTRPC.create();
  const router = t.router({
    foo: {
      bar: {
        throw: t.procedure.mutation(async () => {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Fake error" });
        }),
      },
    },
  });
  const server = createHTTPServer({ router });
  const client = createTRPCClient<typeof router>({
    links: [httpLink({ url: "http://localhost:7500" })],
  });
  server.listen(7500);
  return {
    router,
    trpcClient: client,
    [Symbol.dispose]: () => server.close(),
  };
}

test("trpc client errors", async () => {
  //

  async function functionThatShouldBeInCallStack() {
    using setup = await setupTrpc();
    const wrappedClient = wrapTrpcClient(setup.trpcClient);

    const vanillaClientError = await setup.trpcClient.foo.bar.throw.mutate().catch((e) => e);
    const wrappedClientError = await wrappedClient.foo.bar.throw.mutate().catch((e) => e);

    return { vanillaClientError, wrappedClientError };
  }

  const { vanillaClientError, wrappedClientError } = await functionThatShouldBeInCallStack();

  expect(simplifyCallStack(vanillaClientError.stack)).toMatchInlineSnapshot(`
    "TRPCClientError: Fake error
        at TRPCClientError.from (node_modules-blah-blah/@trpc/node_modules-more-blah-blah)
        at node_modules-blah-blah/@trpc/node_modules-more-blah-blah
        at processTicksAndRejections (node:internal/...)"
  `);
  expect(simplifyCallStack(wrappedClientError.stack)).toMatchInlineSnapshot(`
    "TRPCClientError: Fake error
        at TRPCClientError.from (node_modules-blah-blah/@trpc/node_modules-more-blah-blah)
        at node_modules-blah-blah/@trpc/node_modules-more-blah-blah
        at processTicksAndRejections (node:internal/...)
        at processTicksAndRejections (node:internal/...)
        at functionThatShouldBeInCallStack ({cwd}/app/trpc.test.ts:37:32)
        at {cwd}/app/trpc.test.ts:42:54
        at node_modules-blah-blah/@vitest/node_modules-more-blah-blah"
  `);

  expect(vanillaClientError.stack).not.toContain("functionThatShouldBeInCallStack");
  expect(wrappedClientError.stack).toContain("functionThatShouldBeInCallStack");

  //
});

const wrapTrpcClient = <T>(input: T): T => {
  return new Proxy<any>(
    async (...args: any[]) => {
      try {
        return await (input as Function)(...args);
      } catch (error) {
        if (typeof (error as Error)?.stack !== "string") throw error;
        const { stack = "" } = new Error(String(error));
        (error as Error).stack += stack.slice(stack.indexOf("\n") + 1);
        throw error;
      }
    },
    {
      get(_target, prop) {
        return wrapTrpcClient(input[prop as keyof T] as Function);
      },
    },
  );
};

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
