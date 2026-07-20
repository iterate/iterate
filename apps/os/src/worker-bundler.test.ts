import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkerBundlerEntrypoint from "./worker-bundler.ts";

const { createApp, createMemoryStorage, createWorker, handleAssetRequest, storage } = vi.hoisted(
  () => ({
    createApp: vi.fn(),
    createMemoryStorage: vi.fn(),
    createWorker: vi.fn(),
    handleAssetRequest: vi.fn(),
    storage: { get: vi.fn() },
  }),
);

vi.mock("@cloudflare/worker-bundler", () => ({
  createApp,
  createMemoryStorage,
  createWorker,
  handleAssetRequest,
}));

const bundler = Object.create(WorkerBundlerEntrypoint.prototype) as WorkerBundlerEntrypoint;

beforeEach(() => {
  createApp.mockReset();
  createMemoryStorage.mockReset();
  createMemoryStorage.mockReturnValue(storage);
  createWorker.mockReset();
  handleAssetRequest.mockReset();
});

describe("worker-bundler RPC boundary", () => {
  it("passes an ordinary repo file map and options to one createWorker call", async () => {
    createWorker.mockResolvedValue({
      mainModule: "bundle.js",
      modules: { "bundle.js": "built" },
      wranglerConfig: {
        compatibilityDate: "2026-07-01",
        compatibilityFlags: ["nodejs_compat_v2"],
      },
    });
    await expect(
      bundler.createWorker({
        conditions: ["workerd"],
        entryPoint: "src/worker.ts",
        files: {
          "package.json": JSON.stringify({ dependencies: { hono: "latest" } }),
          "src/worker.ts": "export default {};",
        },
        minify: true,
        virtualModules: { "iterate/sdk": "export {};" },
      }),
    ).resolves.toEqual({
      mainModule: "bundle.js",
      modules: { "bundle.js": "built" },
      warnings: [],
      wranglerConfig: {
        compatibilityDate: "2026-07-01",
        compatibilityFlags: ["nodejs_compat_v2"],
      },
    });
    expect(createWorker).toHaveBeenCalledOnce();
    expect(createWorker).toHaveBeenCalledWith({
      conditions: ["workerd"],
      entryPoint: "src/worker.ts",
      files: {
        "package.json": JSON.stringify({ dependencies: { hono: "latest" } }),
        "src/worker.ts": "export default {};",
      },
      minify: true,
      virtualModules: { "iterate/sdk": "export {};" },
    });
    expect(createApp).not.toHaveBeenCalled();
  });

  it("passes every app file and option to one createApp call", async () => {
    const assetConfig = { not_found_handling: "single-page-application" } as const;
    createApp.mockResolvedValue({
      assetConfig,
      assetManifest: new Map([
        ["/admin.js", { contentType: "application/javascript", etag: "admin-etag" }],
        ["/client.js", { contentType: "application/javascript", etag: "client-etag" }],
      ]),
      assets: { "/admin.js": "admin", "/client.js": "client" },
      clientBundles: ["/client.js", "/admin.js"],
      mainModule: "bundle.js",
      modules: { "bundle.js": "server", "data.json": { json: { ok: true } } },
      warnings: ["worker-bundler chose a fallback package export"],
    });
    const files = {
      "client/admin.tsx": "admin source",
      "client/index.tsx": "client source",
      "package.json": JSON.stringify({ dependencies: { react: "latest" } }),
      "server/index.ts": "server source",
      "shared/model.ts": "export {};",
    };

    await expect(
      bundler.createApp({
        assetConfig,
        assets: { "/robots.txt": "User-agent: *" },
        client: ["client/index.tsx", "client/admin.tsx"],
        externals: ["https://esm.sh/"],
        files,
        jsx: "transform",
        server: "server/index.ts",
      }),
    ).resolves.toEqual({
      assetConfig,
      assetManifest: {
        "/admin.js": { contentType: "application/javascript", etag: "admin-etag" },
        "/client.js": { contentType: "application/javascript", etag: "client-etag" },
      },
      assets: { "/admin.js": "admin", "/client.js": "client" },
      mainModule: "bundle.js",
      modules: { "bundle.js": "server", "data.json": { json: { ok: true } } },
      warnings: ["worker-bundler chose a fallback package export"],
    });
    expect(createApp).toHaveBeenCalledOnce();
    expect(createApp).toHaveBeenCalledWith({
      assetConfig,
      assets: { "/robots.txt": "User-agent: *" },
      client: ["client/index.tsx", "client/admin.tsx"],
      externals: ["https://esm.sh/"],
      files,
      jsx: "transform",
      server: "server/index.ts",
    });
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("preserves non-fatal worker-bundler warnings and JSON/text modules", async () => {
    createWorker.mockResolvedValue({
      mainModule: "src/index.js",
      modules: {
        "copy.txt": { text: "hello" },
        "data.json": { json: { answer: 42 } },
        "src/index.js": "export default {};",
      },
      warnings: ["File not found: optional.js"],
    });
    await expect(
      bundler.createWorker({
        bundle: false,
        entryPoint: "src/index.ts",
        files: { "src/index.ts": "export default {};" },
        virtualModules: {},
      }),
    ).resolves.toMatchObject({
      modules: {
        "copy.txt": { text: "hello" },
        "data.json": { json: { answer: 42 } },
      },
      warnings: ["File not found: optional.js"],
    });
  });

  it("rejects binary outputs that cannot survive the JSON artifact cache", async () => {
    createWorker.mockResolvedValueOnce({
      mainModule: "data.bin",
      modules: { "data.bin": { data: new ArrayBuffer(4) } },
    });
    await expect(
      bundler.createWorker({
        entryPoint: "data.bin",
        files: { "data.bin": "data" },
        virtualModules: {},
      }),
    ).rejects.toThrow(/build cache does not yet encode ArrayBuffers/);

    createApp.mockResolvedValueOnce({
      assetManifest: new Map(),
      assets: { "/icon.png": new ArrayBuffer(4) },
      mainModule: "bundle.js",
      modules: { "bundle.js": "server" },
    });
    await expect(
      bundler.createApp({
        files: { "server.ts": "export default {};" },
        server: "server.ts",
      }),
    ).rejects.toThrow(/build cache currently supports text assets only/);
  });
});

describe("handleAssetRequest", () => {
  it("delegates asset routing to worker-bundler's own handler", async () => {
    const request = new Request("https://app.test/dashboard", {
      headers: { accept: "text/html" },
    });
    const assets = { "/index.html": "<main>app</main>" };
    const manifest = {
      "/index.html": { contentType: "text/html; charset=utf-8", etag: "abc123" },
    };
    const config = { not_found_handling: "single-page-application" } as const;
    const response = new Response("<main>app</main>");
    handleAssetRequest.mockResolvedValue(response);

    await expect(bundler.handleAssetRequest(request, manifest, assets, config)).resolves.toBe(
      response,
    );
    expect(createMemoryStorage).toHaveBeenCalledWith(assets);
    expect(handleAssetRequest).toHaveBeenCalledWith(
      request,
      new Map([["/index.html", { contentType: "text/html; charset=utf-8", etag: "abc123" }]]),
      storage,
      config,
    );
  });
});
