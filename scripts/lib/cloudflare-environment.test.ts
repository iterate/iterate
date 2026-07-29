import { describe, expect, it } from "vitest";
import { destroyWranglerEnvironment } from "./cloudflare-environment.ts";
import { CloudflareApiError } from "./env-context.ts";

describe("destroyWranglerEnvironment", () => {
  it("stops Workers before draining every page of Artifact repos", async () => {
    const calls: Array<{ init?: RequestInit; path: string }> = [];
    let repositories = Array.from({ length: 51 }, (_, index) => ({
      name: index === 0 ? "project-one" : `project-${index + 1}`,
    }));
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
        return repositories.slice(0, 50) as T;
      }
      if (path.startsWith("/artifacts/namespaces/os-preview-1-repos/repos/")) {
        const name = decodeURIComponent(path.split("/").at(-1) ?? "");
        repositories = repositories.filter((repository) => repository.name !== name);
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
    expect(
      calls.filter(({ path }) =>
        path.startsWith("/artifacts/namespaces/os-preview-1-repos/repos/project-"),
      ),
    ).toHaveLength(51);
    expect(calls.findIndex(({ path }) => path === "/containers/applications/app-one")).toBeLessThan(
      calls.findIndex(({ path }) => path === "/workers/scripts/os-preview-1?force=true"),
    );
    expect(
      calls.findIndex(({ path }) => path === "/workers/scripts/os-preview-1?force=true"),
    ).toBeLessThan(
      calls.findIndex(
        ({ path }) => path === "/artifacts/namespaces/os-preview-1-repos/repos/project-one",
      ),
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

  it("discovers every Worker in one exact preview slot without scanning settings", async () => {
    const calls: Array<{ init?: RequestInit; path: string }> = [];
    let workers = [
      { id: "os-preview-5" },
      { id: "os-preview-5-typechecker" },
      { id: "docs-preview-5" },
      { id: "auth-preview-5" },
      { id: "os-preview-50" },
      { id: "not-preview-5x" },
      { id: "alchemy-state-store" },
    ];
    const cf = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ init, path });
      if (path === "/workers/scripts") return workers as T;
      if (path.startsWith("/workers/durable_objects/namespaces?")) return [] as T;
      const workerMatch = /^\/workers\/scripts\/([^?]+)\?force=true$/.exec(path);
      if (workerMatch) {
        const workerName = decodeURIComponent(workerMatch[1]);
        workers = workers.filter(({ id }) => id !== workerName);
        return {} as T;
      }
      throw new Error(`Unexpected Cloudflare API call ${path}`);
    };

    await destroyWranglerEnvironment({
      ctx: { cf },
      previewSlot: 5,
    });

    expect(
      calls
        .filter(({ init, path }) => init?.method === "DELETE" && path.includes("/workers/scripts/"))
        .map(({ path }) => path),
    ).toEqual([
      "/workers/scripts/os-preview-5?force=true",
      "/workers/scripts/os-preview-5-typechecker?force=true",
      "/workers/scripts/docs-preview-5?force=true",
      "/workers/scripts/auth-preview-5?force=true",
    ]);
    expect(calls.filter(({ path }) => path === "/workers/scripts")).toHaveLength(2);
    expect(calls.some(({ path }) => path.endsWith("/settings"))).toBe(false);
    expect(workers).toEqual([
      { id: "os-preview-50" },
      { id: "not-preview-5x" },
      { id: "alchemy-state-store" },
    ]);
  });

  it("fails instead of looping when listed Artifact repos are already absent", async () => {
    const cf = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
      if (path.startsWith("/artifacts/namespaces/os-preview-1-repos/repos?")) {
        return [{ name: "stale-repository" }] as T;
      }
      if (path.startsWith("/artifacts/namespaces/os-preview-1-repos/repos/")) {
        throw new CloudflareApiError(init?.method ?? "GET", path, 404, []);
      }
      return [] as T;
    };

    await expect(
      destroyWranglerEnvironment({
        ctx: { cf },
        osWorkerName: "os-preview-1",
        workerNames: ["os-preview-1"],
      }),
    ).rejects.toThrow(
      "Artifacts cleanup made no progress for os-preview-1-repos; Cloudflare still lists: stale-repository",
    );
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
