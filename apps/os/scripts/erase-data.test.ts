import { expect, test, vi } from "vitest";
import { eraseDataWith } from "./erase-data.ts";

test("production requires explicit confirmation before contacting any service", async () => {
  using fixture = eraseFixture();
  await expect(eraseDataWith({ env: "prd" }, fixture.services)).rejects.toThrow("--yes-i-mean-prd");
  expect(fixture.services.resolveEnvContext).not.toHaveBeenCalled();
});
test("dry run inventories every resource without parking or changing data", async () => {
  using fixture = eraseFixture();
  await eraseDataWith({ env: "preview", dryRun: true }, fixture.services);
  expect(fixture).toMatchObject({ operations: [] });
  expect(fixture.stores.get("oauth")).toHaveLength(2);
  expect(console.log).toHaveBeenCalledWith("OAuth KV before: 2");
  expect(console.log).toHaveBeenCalledWith("R2 files before: 1");
  expect(console.log).toHaveBeenCalledWith("Artifacts repositories before: 1");
});
test("stops writers first and verifies all data stores empty, including later KV pages", async () => {
  using fixture = eraseFixture();
  const erased = eraseDataWith({ env: "preview" }, fixture.services);
  await vi.runAllTimersAsync();
  await erased;
  expect(fixture).toMatchObject({
    operations: ["retire", "clear-oauth", "clear-itx", "clear-files", "clear-repos"],
  });
  expect([...fixture.stores.values()].flat()).toEqual([]);
});
test("remaining Durable Objects prevent resource deletion", async () => {
  using fixture = eraseFixture();
  fixture.retainNamespace = true;
  await expect(eraseDataWith({ env: "preview" }, fixture.services)).rejects.toThrow(
    "namespaces remain",
  );
  expect(fixture).toMatchObject({ operations: ["retire"] });
});
test("a preview parent with branch namespaces cannot be erased by class name", async () => {
  using fixture = eraseFixture();
  fixture.branchNamespaces = true;
  await expect(eraseDataWith({ env: "preview" }, fixture.services)).rejects.toThrow(
    "branch previews",
  );
  expect(fixture).toMatchObject({ operations: [] });
});
test("another worker sharing a data store prevents all mutations", async () => {
  using fixture = eraseFixture();
  fixture.sharedConsumer = true;
  await expect(eraseDataWith({ env: "preview" }, fixture.services)).rejects.toThrow(
    "Other workers still use",
  );
  expect(fixture).toMatchObject({ operations: [] });
});
test("an active worker without Durable Objects cannot keep writing during an erase", async () => {
  using fixture = eraseFixture();
  fixture.retainBindings = true;
  await expect(eraseDataWith({ env: "preview" }, fixture.services)).rejects.toThrow(
    "still has data bindings",
  );
  expect(fixture).toMatchObject({ operations: ["retire"] });
});
test("a failed resource deletion aborts instead of reporting a successful erase", async () => {
  using fixture = eraseFixture();
  const cf = fixture.cf.getMockImplementation()!;
  fixture.cf.mockImplementation((route, init) => {
    if (route.includes("/oauth/bulk")) throw new Error("provider refused deletion");
    return cf(route, init);
  });
  await expect(eraseDataWith({ env: "preview" }, fixture.services)).rejects.toThrow(
    "provider refused deletion",
  );
  expect(fixture.stores.get("oauth")).toHaveLength(2);
  expect(fixture.stores.get("files")).toHaveLength(1);
  expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("verified empty"));
});

/** One preview deployment's Cloudflare account as fakes: the worker and its Durable Object
 *  namespaces (the erase's services), the Cloudflare API behind the context's `cf`, and the four
 *  data stores behind the listing `fetch`. The flags set before an erase shape what it finds;
 *  `operations` records what it did, in order. Fake timers, the `fetch` stub and the console spy
 *  are restored on dispose. */
function eraseFixture() {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const fixture = {
    parked: false,
    retainNamespace: false,
    branchNamespaces: false,
    retainBindings: false,
    sharedConsumer: false,
    operations: [] as string[],
    stores: new Map([
      ["oauth", ["old-grant", "old-client"]],
      ["itx", ["old-value"]],
      ["files", ["old-file"]],
      ["repos", ["old-repo"]],
    ]),
    cf: vi.fn(async (route: string, init?: RequestInit): Promise<unknown> => {
      if (route === "/workers/scripts")
        return [
          { id: "os-next-preview" },
          ...(fixture.sharedConsumer ? [{ id: "old-worker" }] : []),
        ];
      if (route === "/workers/scripts/old-worker/settings")
        return { bindings: [{ name: "OAUTH_KV", type: "kv_namespace", namespace_id: "oauth" }] };
      if (route.endsWith("/settings"))
        return {
          bindings: fixture.retainBindings ? [{ name: "OAUTH_KV", type: "kv_namespace" }] : [],
        };
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(fixture).toMatchObject({ parked: true });
      const store = storeOf(route);
      fixture.operations.push(`clear-${store}`);
      const removed = Array.isArray(body) ? body : [decodeURIComponent(route.split("/").at(-1)!)];
      fixture.stores.set(
        store,
        fixture.stores.get(store)!.filter((name) => !removed.includes(name)),
      );
      return [];
    }),
    services: {
      resolveEnvContext: vi.fn(async () => ({
        name: "preview",
        secrets: { CLOUDFLARE_API_TOKEN: "test-token" },
        cf: fixture.cf,
        env: {
          workerName: "os-next-preview",
          cloudflareAccountId: "test-account",
          resourceNamePrefix: "os-next-preview",
          artifactsNamespace: "os-next-preview-repos",
          resources: { oauthKvId: "oauth", itxKvId: "itx" },
        },
      })),
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
    } as unknown as Parameters<typeof eraseDataWith>[1],
    [Symbol.dispose]() {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      log.mockRestore();
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const store = storeOf(url);
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
  return fixture;
}

/** The data store a Cloudflare route or URL addresses. */
function storeOf(route: string) {
  return route.includes("/oauth/")
    ? "oauth"
    : route.includes("/itx/")
      ? "itx"
      : route.includes("/r2/")
        ? "files"
        : "repos";
}
