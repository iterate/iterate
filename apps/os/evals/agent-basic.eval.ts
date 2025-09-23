import { evalite } from "evalite";
import { Levenshtein } from "autoevals";
import { createTRPCClient, httpLink } from "@trpc/client";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import type { AppRouter } from "../backend/trpc/root.ts";

export const authClient = createAuthClient({
  baseURL: "http://localhost:5173/api/auth",
  plugins: [adminClient()],
});

const serviceAuthToken = process.env.SERVICE_AUTH_TOKEN;
if (!serviceAuthToken) {
  throw new Error("SERVICE_AUTH_TOKEN environment variable is required");
}

evalite("My Eval", {
  // A function that returns an array of test data
  // - TODO: Replace with your test data
  data: async () => {
    return [{ input: "Hello", expected: "Hello World!" }];
  },
  // The task to perform
  // - TODO: Replace with your LLM call
  task: async (input) => {
    const unauthedClient = createTRPCClient<AppRouter>({
      links: [httpLink({ url: "http://localhost:5173/api/trpc" })],
    });
    const foo = await unauthedClient.test.mutate();
    console.log(foo);
    const lo = await fetch("http://localhost:5173/api/auth/sign-in/email", {
      method: "POST",
      body: JSON.stringify({ email: "admin@example.com", password: "password" }),
      headers: { "Content-Type": "application/json" },
    });
    const loData = await lo.text();
    console.log({ loData });
    // return JSON.stringify(foo);
    // const admin = await authClient.admin.createUser({
    //   email: "test@test.com",
    //   name: "Test User",
    //   password: "password",
    //   role: "admin",
    // });
    // console.log(admin);
    const trpcClient = createTRPCClient<AppRouter>({
      links: [
        httpLink({
          url: "http://localhost:5173/api/trpc",
          headers: {
            cookie: lo.headers.getSetCookie().join("; "),
          },
        }),
      ],
    });
    const estates = await trpcClient.estates.list.query();
    console.log({ estates });
    const estateId = estates[0].id;
    return JSON.stringify(estates);
    const result = await trpcClient.agents.list.query({ estateId });
    return JSON.stringify(result);
    // return input + " World";
  },
  // The scoring methods for the eval
  scorers: [
    Levenshtein,
    {
      name: "exact_match",
      scorer: ({ output, expected }) => {
        return {
          score: output === expected ? 1 : 0,
          metadata: {
            description: "only the best will do",
            foo: "bar;",
            nested: {
              more: {
                deeply: {
                  x: 123,
                },
              },
            },
          },
        };
      },
      description: "Exact match",
    },
  ],
});
