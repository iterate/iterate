import { describe, expect, test } from "vitest";
import type { FetchHandleResult, FetchHandlerInterceptorOptions } from "@orpc/server/fetch";
import type { Context } from "@orpc/server";
import { prettyJsonInterceptor } from "./pretty-json-interceptor.ts";

function makeOptions(params: { userAgent?: string; result: FetchHandleResult }) {
  const headers = new Headers();
  if (params.userAgent) headers.set("user-agent", params.userAgent);
  return {
    request: new Request("https://os.example.com/api/projects", { headers }),
    context: {},
    next: () => Promise.resolve(params.result),
  } as unknown as FetchHandlerInterceptorOptions<Context> & {
    next(): Promise<FetchHandleResult>;
  };
}

function jsonResult(body: unknown): FetchHandleResult {
  return {
    matched: true,
    response: Response.json(body),
  };
}

describe("prettyJsonInterceptor", () => {
  test.for(["curl/8.7.1", "HTTPie/3.2.2", "Wget/1.24.5"])(
    "pretty-prints JSON for %s",
    async (userAgent) => {
      const result = await prettyJsonInterceptor(
        makeOptions({ userAgent, result: jsonResult({ a: 1, b: [2] }) }),
      );
      expect(result.matched).toBe(true);
      expect(await result.response?.text()).toMatchInlineSnapshot(`
        "{
          "a": 1,
          "b": [
            2
          ]
        }"
      `);
    },
  );

  test("passes browser responses through without buffering", async () => {
    const original = jsonResult({ a: 1 });
    const result = await prettyJsonInterceptor(
      makeOptions({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        result: original,
      }),
    );
    // Same result object, same Response instance: the body was never consumed.
    expect(result).toBe(original);
    expect(original.response?.bodyUsed).toBe(false);
    expect(await result.response?.text()).toBe(`{"a":1}`);
  });

  test("passes requests without a user-agent through untouched", async () => {
    const original = jsonResult({ a: 1 });
    const result = await prettyJsonInterceptor(makeOptions({ result: original }));
    expect(result).toBe(original);
  });

  test("leaves SSE responses untouched even for curl", async () => {
    const original: FetchHandleResult = {
      matched: true,
      response: new Response("data: hello\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
    };
    const result = await prettyJsonInterceptor(
      makeOptions({ userAgent: "curl/8.7.1", result: original }),
    );
    expect(result).toBe(original);
    expect(original.response?.bodyUsed).toBe(false);
  });

  test("leaves unmatched results untouched", async () => {
    const original: FetchHandleResult = { matched: false, response: undefined };
    const result = await prettyJsonInterceptor(
      makeOptions({ userAgent: "curl/8.7.1", result: original }),
    );
    expect(result).toBe(original);
  });
});
