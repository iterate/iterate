import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envs } from "../../../envs.ts";

const mocks = vi.hoisted(() => ({
  cf: vi.fn(async (_path: string, _init?: RequestInit): Promise<unknown> => []),
  createCliRun: vi.fn(),
  resetWorkerDurableObjects: vi.fn(async () => {}),
  resolveEnvContext: vi.fn(),
  wipeD1Tables: vi.fn(async () => {}),
  wipeRemoteUserDataBuckets: vi.fn(async () => [
    { bucketName: "os-preview-2-files", objectsDeleted: 2 },
    { bucketName: "os-preview-2-sandboxes", objectsDeleted: 4 },
    { bucketName: "os-preview-2-search-index", objectsDeleted: 3 },
  ]),
}));

vi.mock("trpc-cli", () => ({
  createBuiltInPrompts: vi.fn(),
  createCli: vi.fn(() => ({ run: mocks.createCliRun })),
  isAgent: vi.fn(() => true),
  yamlTableConsoleLogger: {},
}));
vi.mock("../../../scripts/lib/deploy-helpers.ts", () => ({
  wipeD1Tables: mocks.wipeD1Tables,
}));
vi.mock("../../../scripts/lib/do-reset.ts", () => ({
  resetWorkerDurableObjects: mocks.resetWorkerDurableObjects,
}));
vi.mock("../../../scripts/lib/env-context.ts", () => ({
  resolveEnvContext: mocks.resolveEnvContext,
}));
vi.mock("./generate-wrangler-config.ts", () => ({
  COMPATIBILITY_DATE: "2026-07-13",
}));
vi.mock("./r2-wipe.ts", () => ({
  wipeRemoteUserDataBuckets: mocks.wipeRemoteUserDataBuckets,
}));

import eraseData from "./erase-data.ts";

const selectedEnv = envs.preview_2;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.cf.mockResolvedValue([]);
  mocks.resetWorkerDurableObjects.mockResolvedValue(undefined);
  mocks.wipeD1Tables.mockResolvedValue(undefined);
  mocks.wipeRemoteUserDataBuckets.mockResolvedValue([
    { bucketName: "os-preview-2-files", objectsDeleted: 2 },
    { bucketName: "os-preview-2-sandboxes", objectsDeleted: 4 },
    { bucketName: "os-preview-2-search-index", objectsDeleted: 3 },
  ]);
  mocks.resolveEnvContext.mockResolvedValue({
    name: "preview_2",
    env: selectedEnv,
    cf: mocks.cf,
    cfV4: vi.fn(),
    secrets: {
      CLOUDFLARE_API_TOKEN: "selected-api-token",
    },
  });
});

afterEach(() => vi.restoreAllMocks());

describe("eraseData", () => {
  it("parks Durable Objects before storage and wipes R2 with the selected environment", async () => {
    await eraseData({ env: "preview_2" });

    expect(mocks.resolveEnvContext).toHaveBeenCalledExactlyOnceWith({
      envs,
      dopplerProject: "os",
      env: "preview_2",
    });
    expect(mocks.wipeRemoteUserDataBuckets).toHaveBeenCalledExactlyOnceWith({
      accountId: selectedEnv.cloudflareAccountId,
      apiToken: "selected-api-token",
      compatibilityDate: "2026-07-13",
      workerName: selectedEnv.osWorkerName,
    });
    expect(mocks.resetWorkerDurableObjects.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.wipeD1Tables.mock.invocationCallOrder[0] as number,
    );
    expect(mocks.wipeD1Tables.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.cf.mock.invocationCallOrder[0] as number,
    );
    expect(mocks.cf.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.wipeRemoteUserDataBuckets.mock.invocationCallOrder[0] as number,
    );
    expect(mocks.cf).toHaveBeenCalledWith(
      `/ai-search/namespaces?per_page=100&search=${selectedEnv.osWorkerName}`,
    );
  });

  it("fails closed when the AI Search namespace listing fails", async () => {
    const failure = new Error("AI Search unavailable");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.cf.mockImplementation(async (path: string) => {
      if (path.startsWith("/storage/kv/")) return [];
      throw failure;
    });

    await expect(eraseData({ env: "preview_2" })).rejects.toBe(failure);

    expect(mocks.wipeRemoteUserDataBuckets).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().some((value) => String(value).includes("data erased"))).toBe(
      false,
    );
  });

  it("fails closed after a partial AI Search instance page deletion", async () => {
    const failure = new Error("second delete failed");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const instancesPath = `/ai-search/namespaces/${selectedEnv.osWorkerName}/instances`;
    mocks.cf.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/storage/kv/")) return [];
      if (path.startsWith("/ai-search/namespaces?")) {
        return [{ name: selectedEnv.osWorkerName }];
      }
      if (path === `${instancesPath}?per_page=100&page=1`) {
        return [{ id: "first" }, { id: "second" }];
      }
      if (path === `${instancesPath}/first` && init?.method === "DELETE") return {};
      if (path === `${instancesPath}/second` && init?.method === "DELETE") throw failure;
      throw new Error(`Unexpected Cloudflare call ${path}`);
    });

    await expect(eraseData({ env: "preview_2" })).rejects.toBe(failure);

    expect(mocks.wipeRemoteUserDataBuckets).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().some((value) => String(value).includes("data erased"))).toBe(
      false,
    );
  });

  it("rejects malformed AI Search management responses", async () => {
    mocks.cf.mockImplementation(async (path: string) => {
      if (path.startsWith("/storage/kv/")) return [];
      return [{ wrong: "shape" }];
    });

    await expect(eraseData({ env: "preview_2" })).rejects.toThrow();
    expect(mocks.wipeRemoteUserDataBuckets).not.toHaveBeenCalled();
  });

  it("fails closed and does not report success when R2 cleanup fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.wipeRemoteUserDataBuckets.mockRejectedValueOnce(new Error("R2 unavailable"));

    await expect(eraseData({ env: "preview_2" })).rejects.toThrow("R2 unavailable");

    expect(log.mock.calls.flat().some((value) => String(value).includes("data erased"))).toBe(
      false,
    );
  });
});
