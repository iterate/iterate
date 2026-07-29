import { describe, expect, it } from "vitest";
import { destroyWranglerEnvironment } from "./cloudflare-environment.ts";
import { CloudflareApiError } from "./env-context.ts";

describe("destroyWranglerEnvironment", () => {
  it("deletes repositories and container apps before force-deleting Workers and their DOs", async () => {
    const calls: Array<{ init?: RequestInit; path: string }> = [];
    let repositories = [{ name: "project-one" }];
    let applications = [
      {
        id: "app-one",
        name: "sandbox",
        durable_objects: { namespace_id: "os-namespace" },
      },
      {
        id: "unrelated-app",
        name: "other",
        durable_objects: { namespace_id: "other-namespace" },
      },
    ];
    let workers = [{ id: "os-preview-1" }, { id: "auth-preview-1" }, { id: "other" }];
    let namespaces = [
      { id: "os-namespace", script: "os-preview-1" },
      { id: "auth-namespace", script: "auth-preview-1" },
      { id: "other-namespace", script: "other" },
    ];
    const cf = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ init, path });
      if (path.startsWith("/artifacts/namespaces/os-preview-1-repos/repos?")) {
        return repositories as T;
      }
      if (path === "/artifacts/namespaces/os-preview-1-repos/repos/project-one") {
        repositories = [];
        return {} as T;
      }
      if (path.startsWith("/workers/durable_objects/namespaces?")) return namespaces as T;
      if (path === "/containers/applications") return applications as T;
      if (path === "/containers/applications/app-one") {
        applications = applications.filter(({ id }) => id !== "app-one");
        return {} as T;
      }
      const workerMatch = /^\/workers\/scripts\/([^?]+)\?force=true$/.exec(path);
      if (workerMatch) {
        const workerName = decodeURIComponent(workerMatch[1]);
        workers = workers.filter(({ id }) => id !== workerName);
        namespaces = namespaces.filter(({ script }) => script !== workerName);
        return {} as T;
      }
      if (path === "/workers/scripts") return workers as T;
      throw new Error(`Unexpected Cloudflare API call ${path}`);
    };

    await destroyWranglerEnvironment({
      ctx: { cf },
      osWorkerName: "os-preview-1",
      workerNames: ["os-preview-1", "auth-preview-1"],
    });

    expect(repositories).toEqual([]);
    expect(applications).toEqual([
      {
        id: "unrelated-app",
        name: "other",
        durable_objects: { namespace_id: "other-namespace" },
      },
    ]);
    expect(workers).toEqual([{ id: "other" }]);
    expect(namespaces).toEqual([{ id: "other-namespace", script: "other" }]);
    expect(calls.findIndex(({ path }) => path === "/containers/applications/app-one")).toBeLessThan(
      calls.findIndex(({ path }) => path === "/workers/scripts/os-preview-1?force=true"),
    );
  });

  it("is an idempotent no-op when the environment is already absent", async () => {
    const cf = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      if (path.startsWith("/artifacts/")) {
        throw new CloudflareApiError(init?.method ?? "GET", path, 404, []);
      }
      if (path.startsWith("/workers/scripts/") && init?.method === "DELETE") {
        throw new CloudflareApiError("DELETE", path, 404, []);
      }
      return [] as T;
    };

    await expect(
      destroyWranglerEnvironment({
        ctx: { cf },
        osWorkerName: "os-preview-1",
        workerNames: ["os-preview-1"],
      }),
    ).resolves.toBeUndefined();
  });

  it("fails when Cloudflare reports a deletion but retains the Worker", async () => {
    const cf = async <T = unknown>(path: string): Promise<T> => {
      if (path === "/workers/scripts") return [{ id: "auth-dev-global" }] as T;
      if (path.startsWith("/workers/durable_objects/namespaces?")) return [] as T;
      return {} as T;
    };

    await expect(
      destroyWranglerEnvironment({
        ctx: { cf },
        workerNames: ["auth-dev-global"],
      }),
    ).rejects.toThrow("Workers remain: auth-dev-global");
  });
});
