import { afterEach, describe, expect, it, vi } from "vitest";
import { deployApp, runTimedDeployPhase } from "./deploy-app.ts";

const mocks = vi.hoisted(() => ({
  assertProvisioned: vi.fn(),
  collectSecrets: vi.fn(() => ({})),
  deployWithSecrets: vi.fn(async () => undefined),
  findBuiltWranglerConfig: vi.fn(() => "/app/dist/wrangler.json"),
  resolveEnvContext: vi.fn(async () => ({
    cf: vi.fn(),
    cfV4: vi.fn(),
    env: { cloudflareAccountId: "account", dopplerConfig: "preview_1" },
    name: "preview_1",
    secrets: { CLOUDFLARE_API_TOKEN: "token" },
  })),
  runAsync: vi.fn(async () => undefined),
  smoke: vi.fn(async () => undefined),
}));

vi.mock("./deploy-helpers.ts", () => ({
  collectSecrets: mocks.collectSecrets,
  deployWithSecrets: mocks.deployWithSecrets,
  findBuiltWranglerConfig: mocks.findBuiltWranglerConfig,
  runAsync: mocks.runAsync,
  smoke: mocks.smoke,
}));

vi.mock("./env-context.ts", () => ({
  assertProvisioned: mocks.assertProvisioned,
  resolveEnvContext: mocks.resolveEnvContext,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("runTimedDeployPhase", () => {
  it("records a successful phase without changing its result", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runTimedDeployPhase("apps/example", "upload", async () => "deployed"),
    ).resolves.toBe("deployed");

    expect(log).toHaveBeenNthCalledWith(1, "[deploy:apps/example] phase start: upload");
    expect(log.mock.calls.at(-1)?.[0]).toMatch(
      /^\[deploy:apps\/example\] phase finish: upload \(\d+\.\d+s, passed\)$/,
    );
  });

  it("records a failed phase and preserves the original error", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const failure = new Error("control plane refused the upload");

    await expect(
      runTimedDeployPhase("apps/example", "upload", () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(log.mock.calls.at(-1)?.[0]).toMatch(
      /^\[deploy:apps\/example\] phase finish: upload \(\d+\.\d+s, failed\)$/,
    );
  });
});

describe("deployApp upload preparation", () => {
  it("starts independent remote preparation before build and joins both before upload", async () => {
    const events: string[] = [];
    const preparation = Promise.withResolvers<void>();
    const build = Promise.withResolvers<void>();
    mocks.runAsync.mockImplementation(async () => {
      events.push("build");
      await build.promise;
      events.push("build-finish");
    });
    mocks.deployWithSecrets.mockImplementation(async () => {
      events.push("upload");
    });

    const deployment = deployApp({
      appLabel: "apps/example",
      appRoot: "/app",
      dopplerProject: "example",
      env: "preview_1",
      envs: {
        preview_1: { cloudflareAccountId: "account", dopplerConfig: "preview_1" },
      },
      prepareForUpload: async () => {
        events.push("prepare-start");
        await preparation.promise;
        events.push("prepare-finish");
      },
      servingUrl: () => "https://example.test",
      smokes: () => [],
      workerName: () => "example-preview-1",
    });

    await vi.waitFor(() => {
      expect(events).toEqual(["prepare-start", "build"]);
    });
    expect(mocks.deployWithSecrets).not.toHaveBeenCalled();

    preparation.resolve();
    await vi.waitFor(() => {
      expect(events).toEqual(["prepare-start", "build", "prepare-finish"]);
    });
    expect(mocks.deployWithSecrets).not.toHaveBeenCalled();

    build.resolve();
    await deployment;

    expect(events).toEqual(["prepare-start", "build", "prepare-finish", "build-finish", "upload"]);
    expect(mocks.runAsync).toHaveBeenCalledWith("pnpm", ["exec", "vite", "build"], {
      cwd: "/app",
      env: { CLOUDFLARE_ENV: "preview_1" },
    });
  });

  it("resolves app-specific Wrangler flags after deployment preflight", async () => {
    let reuseContainers = false;

    await deployApp({
      appLabel: "apps/example",
      appRoot: "/app",
      dopplerProject: "example",
      env: "preview_1",
      envs: {
        preview_1: { cloudflareAccountId: "account", dopplerConfig: "preview_1" },
      },
      prepare: () => {
        reuseContainers = true;
      },
      deployArgs: () => (reuseContainers ? ["--containers-rollout", "none"] : []),
      servingUrl: () => "https://example.test",
      smokes: () => [],
      workerName: () => "example-preview-1",
    });

    expect(mocks.deployWithSecrets).toHaveBeenCalledWith(
      expect.objectContaining({ extraDeployArgs: ["--containers-rollout", "none"] }),
    );
  });
});
