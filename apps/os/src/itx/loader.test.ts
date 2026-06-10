// prefetchItxQuery is best-effort BY CONTRACT: it must seed the cache on
// success and silently skip on any failure (no principal during SSR,
// forbidden project, dead DO) — a prefetch failure crashing a route into the
// generic error boundary is the prod incident this design exists to prevent.
// These tests run uncompiled, where createIsomorphicFn falls back to the
// .server() branch — so they exercise the getServerItx wiring via the mock.

import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Itx } from "./handle.ts";
import { getServerItx } from "./server.ts";
import { getLoaderItx, prefetchItxQuery, type ItxQueryDefinition } from "./loader.ts";

vi.mock("./server.ts", () => ({ getServerItx: vi.fn() }));

const serverItx = vi.mocked(getServerItx);
const fakeHandle = { fake: "itx-handle" } as unknown as Itx;

function makeQueryClient() {
  // retry: false keeps failure tests fast; the swallow-everything contract
  // under test is independent of the app's retry settings.
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function streamsListQuery(): ItxQueryDefinition<string[]> {
  return {
    project: "prj_test",
    queryKey: ["itx", "project", "prj_test", "streams", "list"],
    queryFn: async (itx) => {
      expect(itx).toBe(fakeHandle);
      return ["/", "/agents"];
    },
    staleTime: 10_000,
  };
}

beforeEach(() => {
  serverItx.mockReset();
});

describe("getLoaderItx (server branch)", () => {
  test("resolves the in-process handle for the requested project", async () => {
    serverItx.mockResolvedValue(fakeHandle);
    await expect(getLoaderItx("my-project")).resolves.toBe(fakeHandle);
    expect(serverItx).toHaveBeenCalledWith("my-project");
  });
});

describe("prefetchItxQuery", () => {
  test("seeds the cache entry the component's useItxQuery will read", async () => {
    serverItx.mockResolvedValue(fakeHandle);
    const queryClient = makeQueryClient();
    const query = streamsListQuery();

    await prefetchItxQuery({ query, queryClient });

    expect(queryClient.getQueryData(query.queryKey)).toEqual(["/", "/agents"]);
    expect(queryClient.getQueryState(query.queryKey)?.status).toBe("success");
  });

  test("swallows handle-resolution failures (no principal / forbidden project)", async () => {
    serverItx.mockRejectedValue(new Error("Project prj_test not found."));
    const queryClient = makeQueryClient();
    const query = streamsListQuery();

    await expect(prefetchItxQuery({ query, queryClient })).resolves.toBeUndefined();

    // The cache holds NOTHING — not even the error: a data-less errored entry
    // would make the consuming component flash its error state on mount
    // before retryOnMount recovers. The component's own query fetches fresh
    // and surfaces any failure in its inline error states.
    expect(queryClient.getQueryData(query.queryKey)).toBeUndefined();
    expect(queryClient.getQueryState(query.queryKey)).toBeUndefined();
  });

  test("a failed revalidation keeps existing data (stale beats empty)", async () => {
    serverItx.mockResolvedValue(fakeHandle);
    const queryClient = makeQueryClient();
    const query = streamsListQuery();
    queryClient.setQueryData(query.queryKey, ["/", "/agents"]);
    // Make the entry stale so ensureQueryData revalidates — and fail that.
    queryClient.getQueryCache().find({ queryKey: query.queryKey })!.setState({
      dataUpdatedAt: 0,
    });
    serverItx.mockRejectedValue(new Error("kaboom"));

    await expect(prefetchItxQuery({ query, queryClient })).resolves.toBeUndefined();

    expect(queryClient.getQueryData(query.queryKey)).toEqual(["/", "/agents"]);
  });

  test("swallows queryFn failures from the kernel", async () => {
    serverItx.mockResolvedValue(fakeHandle);
    const queryClient = makeQueryClient();
    const query: ItxQueryDefinition<string[]> = {
      ...streamsListQuery(),
      queryFn: async () => {
        throw new Error("Global streams need admin access. Narrow to a project first.");
      },
    };

    await expect(prefetchItxQuery({ query, queryClient })).resolves.toBeUndefined();
    expect(queryClient.getQueryData(query.queryKey)).toBeUndefined();
    expect(queryClient.getQueryState(query.queryKey)).toBeUndefined();
  });
});
