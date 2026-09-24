import { afterEach, beforeEach, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  parked: false,
  retainNamespace: false,
  branchNamespaces: false,
  retainBindings: false,
  sharedConsumer: false,
  operations: [] as string[],
  stores: new Map<string, string[]>(),
  cf: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("../../../scripts/lib/env-context.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../scripts/lib/env-context.ts")>()),
  resolveEnvContext: fixture.resolve,
}));
vi.mock("../../../scripts/lib/do-reset.ts", () => ({
  getWorkerDoNamespaces: async () =>
    fixture.parked && !fixture.retainNamespace
      ? []
      : [
          { className: "IterateContextDurableObject", namespaceId: "old-namespace" },
          ...(fixture.branchNamespaces
            ? [{ className: "IterateContextDurableObject", namespaceId: "branch-namespace" }]
            : []),
        ],
  resetWorkerDurableObjects: async () => {
    fixture.operations.push("retire");
    fixture.parked = true;
  },
}));
import eraseData from "./erase-data.ts";

beforeEach(() => {
  vi.useFakeTimers();
  fixture.parked = false;
  fixture.retainNamespace = false;
  fixture.branchNamespaces = false;
  fixture.retainBindings = false;
  fixture.sharedConsumer = false;
  fixture.operations = [];
  fixture.stores = new Map([
    ["oauth", ["old-grant", "old-client"]],
    ["itx", ["old-value"]],
    ["files", ["old-file"]],
    ["repos", ["old-repo"]],
  ]);
  fixture.cf.mockReset().mockImplementation(async (route: string, init?: RequestInit) => {
    if (route === "/workers/scripts")
      return [{ id: "os-preview" }, ...(fixture.sharedConsumer ? [{ id: "old-worker" }] : [])];
    if (route === "/workers/scripts/old-worker/settings")
      return { bindings: [{ name: "OAUTH_KV", type: "kv_namespace", namespace_id: "oauth" }] };
    if (route.endsWith("/settings"))
      return {
        bindings: fixture.retainBindings ? [{ name: "OAUTH_KV", type: "kv_namespace" }] : [],
      };
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    expect(fixture.parked).toBe(true);
    const store = route.includes("/oauth/")
      ? "oauth"
      : route.includes("/itx/")
        ? "itx"
        : route.includes("/r2/")
          ? "files"
          : "repos";
    fixture.operations.push(`clear-${store}`);
    const removed = Array.isArray(body) ? body : [decodeURIComponent(route.split("/").at(-1)!)];
    fixture.stores.set(
      store,
      fixture.stores.get(store)!.filter((name) => !removed.includes(name)),
    );
    return [];
  });
  fixture.resolve.mockReset().mockResolvedValue({
    name: "preview",
    secrets: { CLOUDFLARE_API_TOKEN: "test-token" },
    cf: fixture.cf,
    env: {
      workerName: "os-preview",
      cloudflareAccountId: "test-account",
      resourceNamePrefix: "os-preview",
      artifactsNamespace: "os-preview-repos",
      resources: { oauthKvId: "oauth", itxKvId: "itx" },
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const store = url.includes("/oauth/")
        ? "oauth"
        : url.includes("/itx/")
          ? "itx"
          : url.includes("/r2/")
            ? "files"
            : "repos";
      const names = fixture.stores.get(store)!;
      // Two pages for OAuth catch accidentally erasing only the first page.
      const second = parsed.searchParams.get("cursor") === "second";
      const page = store === "oauth" && names.length > 1 ? [names[second ? 1 : 0]] : names;
      return Response.json({
        success: true,
        result: page.map((name) => (store === "files" ? { key: name } : { name })),
        result_info: { cursor: store === "oauth" && names.length > 1 && !second ? "second" : "" },
      });
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("production requires explicit confirmation before contacting any service", async () => {
  await expect(eraseData({ env: "prd" })).rejects.toThrow("--yes-i-mean-prd");
  expect(fixture.resolve).not.toHaveBeenCalled();
});
test("dry run inventories every resource without parking or changing data", async () => {
  await eraseData({ env: "preview", dryRun: true });
  expect(fixture.operations).toEqual([]);
  expect(fixture.stores.get("oauth")).toHaveLength(2);
  expect(console.log).toHaveBeenCalledWith("OAuth KV before: 2");
  expect(console.log).toHaveBeenCalledWith("R2 files before: 1");
  expect(console.log).toHaveBeenCalledWith("Artifacts repositories before: 1");
});
test("stops writers first and verifies all data stores empty, including later KV pages", async () => {
  const erased = eraseData({ env: "preview" });
  await vi.runAllTimersAsync();
  await erased;
  expect(fixture.operations).toEqual([
    "retire",
    "clear-oauth",
    "clear-itx",
    "clear-files",
    "clear-repos",
  ]);
  expect([...fixture.stores.values()].flat()).toEqual([]);
});
test("remaining Durable Objects prevent resource deletion", async () => {
  fixture.retainNamespace = true;
  await expect(eraseData({ env: "preview" })).rejects.toThrow("namespaces remain");
  expect(fixture.operations).toEqual(["retire"]);
});
test("a preview parent with branch namespaces cannot be erased by class name", async () => {
  fixture.branchNamespaces = true;
  await expect(eraseData({ env: "preview" })).rejects.toThrow("branch previews");
  expect(fixture.operations).toEqual([]);
});
test("another worker sharing a data store prevents all mutations", async () => {
  fixture.sharedConsumer = true;
  await expect(eraseData({ env: "preview" })).rejects.toThrow("Other workers still use");
  expect(fixture.operations).toEqual([]);
});
test("an active worker without Durable Objects cannot keep writing during an erase", async () => {
  fixture.retainBindings = true;
  await expect(eraseData({ env: "preview" })).rejects.toThrow("still has data bindings");
  expect(fixture.operations).toEqual(["retire"]);
});
test("a failed resource deletion aborts instead of reporting a successful erase", async () => {
  const cf = fixture.cf.getMockImplementation()!;
  fixture.cf.mockImplementation((route, init) => {
    if (route.includes("/oauth/bulk")) throw new Error("provider refused deletion");
    return cf(route, init);
  });
  await expect(eraseData({ env: "preview" })).rejects.toThrow("provider refused deletion");
  expect(fixture.stores.get("oauth")).toHaveLength(2);
  expect(fixture.stores.get("files")).toHaveLength(1);
  expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("verified empty"));
});
