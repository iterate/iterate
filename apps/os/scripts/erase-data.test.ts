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
  expect(console.log).toHaveBeenCalledWith("D1 before: users — 2 rows");
  expect(console.log).toHaveBeenCalledWith("D1 before: projects — 1 rows");
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
    operations: ["retire", "clear-db", "clear-oauth", "clear-itx", "clear-files", "clear-repos"],
  });
  expect([...fixture.stores.values()].flat()).toEqual([]);
  // SQLite's, D1's and wrangler's own tables are never touched; the history keeps the schema's
  expect(fixture).toMatchObject({
    d1: { users: 0, projects: 0, d1_migrations: 1, _cf_KV: 3, sqlite_sequence: 1 },
  });
});
test.for([
  {
    name: "remaining Durable Objects prevent resource deletion",
    flag: "retainNamespace",
    error: "namespaces remain",
    operations: ["retire"],
  },
  {
    name: "two of the worker's own namespaces of one class cannot be erased by class name",
    flag: "branchNamespaces",
    error: "share a class name",
    operations: [],
  },
  {
    name: "another worker sharing a data store prevents all mutations",
    flag: "sharedConsumer",
    error: "Other workers still use",
    operations: [],
  },
  {
    name: "an active worker without Durable Objects cannot keep writing during an erase",
    flag: "retainBindings",
    error: "still has data bindings",
    operations: ["retire"],
  },
] as const)("$name", async ({ flag, error, operations }) => {
  using fixture = eraseFixture();
  fixture[flag] = true;
  await expect(eraseDataWith({ env: "preview" }, fixture.services)).rejects.toThrow(error);
  expect(fixture).toMatchObject({ operations });
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
    /** The D1's tables and their row counts: two of the control plane's, and SQLite's, D1's and
     *  wrangler's own. */
    d1: { users: 2, projects: 1, d1_migrations: 1, _cf_KV: 3, sqlite_sequence: 1 } as Record<
      string,
      number
    >,
    stores: new Map([
      ["oauth", ["old-grant", "old-client"]],
      ["itx", ["old-value"]],
      ["files", ["old-file"]],
      ["repos", ["old-repo"]],
    ]),
    cf: vi.fn(async (route: string, init?: RequestInit): Promise<unknown> => {
      if (route === "/workers/scripts")
        return [{ id: "os-preview" }, ...(fixture.sharedConsumer ? [{ id: "old-worker" }] : [])];
      if (route === "/workers/scripts/old-worker/settings")
        return { bindings: [{ name: "OAUTH_KV", type: "kv_namespace", namespace_id: "oauth" }] };
      if (route.endsWith("/settings"))
        return {
          bindings: fixture.retainBindings ? [{ name: "OAUTH_KV", type: "kv_namespace" }] : [],
        };
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (route === "/d1/database/db/query") return d1Query(body.sql);
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
          workerName: "os-preview",
          cloudflareAccountId: "test-account",
          resourceNamePrefix: "os-preview",
          artifactsNamespace: "os-preview-repos",
          resources: { oauthKvId: "oauth", itxKvId: "itx", dbId: "db" },
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
  /** The D1 `/query` API: each `;`-separated statement's results. */
  const d1Query = (sql: string) =>
    sql.split("; ").flatMap((statement): { results: unknown[] }[] => {
      if (statement === "select name from sqlite_master where type = 'table'")
        return [{ results: Object.keys(fixture.d1).map((name) => ({ name })) }];
      const count = /^select count\(\*\) as rows from "(\w+)"$/.exec(statement);
      if (count) return [{ results: [{ rows: fixture.d1[count[1]!] }] }];
      if (statement === "pragma defer_foreign_keys = on") {
        expect(fixture).toMatchObject({ parked: true });
        fixture.operations.push("clear-db");
        return [{ results: [] }];
      }
      const cleared = /^delete from "(\w+)"$/.exec(statement);
      if (!cleared) throw new Error(`unexpected D1 statement: ${statement}`);
      fixture.d1[cleared[1]!] = 0;
      return [{ results: [] }];
    });
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
