import { describe, expect, test } from "vitest";
import { createIterateQueryClient } from "./query-client.ts";

describe("createIterateQueryClient", () => {
  test("keeps one cache and retry policy across React renderers", () => {
    const client = createIterateQueryClient();

    expect(client.getDefaultOptions()).toEqual({
      queries: {
        staleTime: 60_000,
        gcTime: 300_000,
        retry: 1,
        refetchOnWindowFocus: false,
        refetchOnMount: true,
        refetchOnReconnect: true,
      },
      mutations: { retry: 0 },
    });
  });
});
