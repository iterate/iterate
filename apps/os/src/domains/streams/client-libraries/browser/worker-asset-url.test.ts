import { expect, it } from "vitest";
import { resolveWorkerAssetUrl } from "./worker-asset-url.ts";

it("resolves root-relative assets against the worker origin", () => {
  expect(resolveWorkerAssetUrl("/assets/wa-sqlite.wasm", "https://os.iterate.com")).toBe(
    "https://os.iterate.com/assets/wa-sqlite.wasm",
  );
});

it("preserves absolute asset URLs", () => {
  const assetUrl = "https://cdn.example.com/wa-sqlite.wasm";
  expect(resolveWorkerAssetUrl(assetUrl, "https://os.iterate.com")).toBe(assetUrl);
});
