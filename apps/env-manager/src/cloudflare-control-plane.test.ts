import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCloudflareControlPlane } from "./cloudflare-control-plane.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Cloudflare control plane", () => {
  it("deletes only the compiled Workers and waits for each deletion", async () => {
    const firstDeletion = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>((request) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/workers/durable_objects/namespaces")) {
        return Promise.resolve(
          Response.json({
            success: true,
            result: [],
            errors: [],
          }),
        );
      }
      if (url.pathname.endsWith("/settings")) {
        return Promise.resolve(
          Response.json({
            success: true,
            result: { bindings: [] },
            errors: [],
          }),
        );
      }
      if (
        url.pathname.endsWith("/workers/scripts/worker-one") &&
        url.searchParams.get("force") === "true"
      ) {
        return firstDeletion.promise;
      }
      return Promise.resolve(
        Response.json({
          success: true,
          result: [],
          errors: [],
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);

    const destroyed = makeCloudflareControlPlane({
      accountId: "account-id",
      apiToken: "api-token",
    }).destroyWranglerResources({ workerNames: ["worker-one", "worker-two"] });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(String(fetch.mock.calls[2]?.[0])).toContain("/workers/scripts/worker-one?force=true");

    firstDeletion.resolve(
      Response.json({
        success: true,
        result: null,
        errors: [],
      }),
    );
    await expect(destroyed).resolves.toBeUndefined();

    const requests = fetch.mock.calls.map(([request]) => new URL(String(request)));
    expect(requests.map(({ pathname }) => pathname)).toEqual([
      "/client/v4/accounts/account-id/workers/durable_objects/namespaces",
      "/client/v4/accounts/account-id/workers/scripts/worker-one/settings",
      "/client/v4/accounts/account-id/workers/scripts/worker-one",
      "/client/v4/accounts/account-id/workers/scripts/worker-two/settings",
      "/client/v4/accounts/account-id/workers/scripts/worker-two",
      "/client/v4/accounts/account-id/workers/scripts",
      "/client/v4/accounts/account-id/workers/durable_objects/namespaces",
    ]);
    expect(requests[2]?.searchParams.get("force")).toBe("true");
    expect(requests[4]?.searchParams.get("force")).toBe("true");
  });

  it("deletes owned Durable Object classes before deleting their Worker", async () => {
    let namespaceLists = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((request, init) => {
      const url = new URL(String(request));
      const method = request instanceof Request ? request.method : init?.method;
      if (url.pathname.endsWith("/workers/durable_objects/namespaces")) {
        namespaceLists += 1;
        return Promise.resolve(
          Response.json({
            success: true,
            result:
              namespaceLists === 1
                ? [{ id: "namespace-id", script: "worker-one", class: "Instantiated" }]
                : [],
            result_info: { page: 1, per_page: 100, total_pages: 1 },
            errors: [],
          }),
        );
      }
      if (url.pathname.endsWith("/settings")) {
        return Promise.resolve(
          Response.json({
            success: true,
            result: {
              bindings: [
                {
                  name: "SELF",
                  type: "durable_object_namespace",
                  class_name: "NeverInstantiated",
                },
                {
                  name: "OTHER",
                  type: "durable_object_namespace",
                  class_name: "OtherWorkerClass",
                  script_name: "another-worker",
                },
              ],
            },
            errors: [],
          }),
        );
      }
      if (method === "PUT") {
        return Promise.resolve(
          Response.json({
            success: true,
            result: { startup_time_ms: 0 },
            errors: [],
          }),
        );
      }
      if (method === "DELETE") {
        return Promise.resolve(
          Response.json({
            success: true,
            result: null,
            errors: [],
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          success: true,
          result: [],
          errors: [],
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      makeCloudflareControlPlane({
        accountId: "account-id",
        apiToken: "api-token",
      }).destroyWranglerResources({ workerNames: ["worker-one"] }),
    ).resolves.toBeUndefined();

    const puts = fetch.mock.calls.filter(
      ([request, init]) => (request instanceof Request ? request.method : init?.method) === "PUT",
    );
    expect(puts).toHaveLength(1);
    const metadata = await Promise.all(
      puts.map(async ([request, init]) => {
        const body = request instanceof Request ? await request.clone().formData() : init?.body;
        expect(body).toBeInstanceOf(FormData);
        return JSON.parse(String((body as FormData).get("metadata"))) as {
          exports: Record<string, { type: string; state: string }>;
        };
      }),
    );
    expect(metadata.map(({ exports }) => exports)).toEqual([
      {
        Instantiated: { type: "durable-object", state: "deleted" },
        NeverInstantiated: { type: "durable-object", state: "deleted" },
      },
    ]);

    const requests = fetch.mock.calls.map(([request]) => new URL(String(request)));
    expect(requests.map(({ pathname }) => pathname)).toEqual([
      "/client/v4/accounts/account-id/workers/durable_objects/namespaces",
      "/client/v4/accounts/account-id/workers/durable_objects/namespaces",
      "/client/v4/accounts/account-id/workers/scripts/worker-one/settings",
      "/client/v4/accounts/account-id/workers/scripts/worker-one",
      "/client/v4/accounts/account-id/workers/scripts/worker-one",
      "/client/v4/accounts/account-id/workers/scripts",
      "/client/v4/accounts/account-id/workers/durable_objects/namespaces",
    ]);
    expect(requests[4]?.searchParams.get("force")).toBe("true");
  });

  it("recreates a missing Worker long enough to retire its orphaned namespace", async () => {
    let namespaceLists = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((request, init) => {
      const url = new URL(String(request));
      const method = request instanceof Request ? request.method : init?.method;
      if (url.pathname.endsWith("/workers/durable_objects/namespaces")) {
        namespaceLists += 1;
        return Promise.resolve(
          Response.json({
            success: true,
            result:
              namespaceLists === 1
                ? [{ id: "namespace-id", script: "worker-one", class: "Orphaned" }]
                : [],
            result_info: { page: 1, per_page: 100, total_pages: 1 },
            errors: [],
          }),
        );
      }
      if (url.pathname.endsWith("/settings")) {
        return Promise.resolve(
          Response.json(
            {
              success: false,
              result: null,
              errors: [{ code: 10007, message: "workers.api.error.script_not_found" }],
            },
            { status: 404 },
          ),
        );
      }
      return Promise.resolve(
        Response.json({
          success: true,
          result: method === "GET" ? [] : null,
          errors: [],
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      makeCloudflareControlPlane({
        accountId: "account-id",
        apiToken: "api-token",
      }).destroyWranglerResources({ workerNames: ["worker-one"] }),
    ).resolves.toBeUndefined();

    const put = fetch.mock.calls.find(
      ([request, init]) => (request instanceof Request ? request.method : init?.method) === "PUT",
    );
    expect(put).toBeDefined();
    const body = put?.[0] instanceof Request ? await put[0].clone().formData() : put?.[1]?.body;
    expect(body).toBeInstanceOf(FormData);
    expect(JSON.parse(String((body as FormData).get("metadata")))).toMatchObject({
      compatibility_date: "2026-07-30",
      exports: { Orphaned: { type: "durable-object", state: "deleted" } },
    });
  });

  it("cursor-paginates Artifact repos and deletes each one exactly once", async () => {
    let firstPageReads = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((request, init) => {
      const url = new URL(String(request));
      const method = request instanceof Request ? request.method : init?.method;
      if (url.pathname.endsWith("/artifacts/namespaces/os-worker-repos/repos")) {
        if (url.searchParams.get("cursor") === "next-page") {
          return Promise.resolve(
            Response.json({
              success: true,
              result: [{ name: "three" }],
              result_info: { cursor: null, count: 1, per_page: 200 },
              errors: [],
            }),
          );
        }
        firstPageReads += 1;
        return Promise.resolve(
          Response.json({
            success: true,
            result: firstPageReads === 1 ? [{ name: "one" }, { name: "two" }] : [],
            result_info: {
              cursor: firstPageReads === 1 ? "next-page" : null,
              count: firstPageReads === 1 ? 2 : 0,
              per_page: 200,
            },
            errors: [],
          }),
        );
      }
      return Promise.resolve(
        Response.json({
          success: true,
          result: method === "DELETE" ? null : [],
          errors: [],
        }),
      );
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      makeCloudflareControlPlane({
        accountId: "account-id",
        apiToken: "api-token",
      }).destroyWranglerResources({
        workerNames: [],
        osWorkerName: "os-worker",
      }),
    ).resolves.toBeUndefined();

    const requests = fetch.mock.calls.map(([request]) => new URL(String(request)));
    const artifactLists = requests.filter(({ pathname }) =>
      pathname.endsWith("/artifacts/namespaces/os-worker-repos/repos"),
    );
    expect(artifactLists).toHaveLength(3);
    expect(artifactLists.map(({ searchParams }) => searchParams.get("limit"))).toEqual([
      "200",
      "200",
      "200",
    ]);
    expect(artifactLists.map(({ searchParams }) => searchParams.get("cursor"))).toEqual([
      null,
      "next-page",
      null,
    ]);
    expect(
      requests
        .filter(({ pathname }) => pathname.includes("/artifacts/namespaces/os-worker-repos/repos/"))
        .map(({ pathname }) => pathname.split("/").at(-1))
        .sort(),
    ).toEqual(["one", "three", "two"]);
  });
});
