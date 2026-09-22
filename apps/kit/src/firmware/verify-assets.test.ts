import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyFirmwareAssets } from "../../scripts/verify-firmware-assets.ts";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn() }));
vi.mock("./catalog.ts", () => ({
  firmwareCatalog: [{ id: "satellite1", releases: [{ version: "test" }] }],
  firmwareManifestPath: () => "/firmware/satellite1/test/manifest.json",
}));

const firmware = Buffer.from("firmware release");
const manifest = JSON.stringify({ builds: [{ parts: [{ path: "firmware.bin", offset: 0 }] }] });
const catalog = JSON.stringify({ devices: ["satellite1"] });

describe("deployed firmware verification", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockImplementation(async (path) => {
      const pathname = String(path);
      if (pathname.endsWith("manifest.json")) return manifest;
      if (pathname.endsWith("catalog.json")) return catalog;
      return firmware;
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("waits for a manifest still propagating after fifteen seconds, then verifies the binary", async () => {
    let elapsed = 0;
    vi.mocked(setTimeout).mockImplementation(async (delay) => {
      elapsed += delay ?? 0;
    });
    const fetcher = vi.fn(async (url: URL) => {
      if (url.pathname.endsWith("manifest.json")) {
        return new Response(elapsed < 20_000 ? "previous release" : manifest);
      }
      if (url.pathname.endsWith("catalog.json")) return new Response(catalog);
      return new Response(firmware);
    });
    vi.stubGlobal("fetch", fetcher);

    await verifyFirmwareAssets("https://kit.example");

    expect(elapsed).toBe(20_000);
    expect(fetcher.mock.calls.some(([url]) => url.pathname.endsWith("firmware.bin"))).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      "Verified 1 devices, 1 releases and 1 firmware parts at https://kit.example",
    );
  });

  it("fails a persistent mismatch after the bounded propagation allowance with diagnostic hashes", async () => {
    let elapsed = 0;
    vi.mocked(setTimeout).mockImplementation(async (delay) => {
      elapsed += delay ?? 0;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("wrong release", {
            headers: { "cf-ray": "test-IAD" },
          }),
      ),
    );

    await expect(verifyFirmwareAssets("https://kit.example")).rejects.toThrow(
      `received ${createHash("sha256").update("wrong release").digest("hex")}; CF-Ray test-IAD`,
    );
    expect(elapsed).toBe(120_000);
  });
});
