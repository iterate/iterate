import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneServerBundle } from "./prune-server-bundle.ts";

describe("pruneServerBundle", () => {
  it("deletes sourcemaps and modules unreachable from the entrypoint", async () => {
    const serverDir = await mkdtemp(path.join(tmpdir(), "prune-server-bundle-"));
    await mkdir(path.join(serverDir, "assets"), { recursive: true });

    await write(serverDir, "index.js", [
      `import { a } from "./assets/static-chunk.js";`,
      `const lazy = () => import("./assets/dynamic-chunk.js");`,
      `export * from "./assets/reexported-chunk.js";`,
    ]);
    await write(serverDir, "assets/static-chunk.js", [
      `import wasmUrl from "./referenced.wasm";`,
      `export const a = new URL("./url-referenced-chunk.js", import.meta.url);`,
    ]);
    await write(serverDir, "assets/dynamic-chunk.js", [`export const d = 1;`]);
    await write(serverDir, "assets/reexported-chunk.js", [`export const r = 1;`]);
    await write(serverDir, "assets/url-referenced-chunk.js", [`export const u = 1;`]);
    await write(serverDir, "assets/referenced.wasm", ["wasm"]);
    // Browser-only emissions the server graph never imports.
    await write(serverDir, "assets/browser-worker.js", [`postMessage("hi");`]);
    await write(serverDir, "assets/browser-only.wasm", ["wasm"]);
    // Sourcemaps go regardless of reachability.
    await write(serverDir, "index.js.map", ["{}"]);
    await write(serverDir, "assets/static-chunk.js.map", ["{}"]);
    // Non-module files are not the prune's business (the upload ignores them).
    await write(serverDir, "manifest.json", ["{}"]);

    const result = await pruneServerBundle({ entrypoint: "index.js", serverDir });

    expect(result.deletedModules.sort()).toEqual([
      "assets/browser-only.wasm",
      "assets/browser-worker.js",
    ]);
    // The entrypoint's own map survives for worker stack-trace symbolication.
    expect(result.deletedSourcemaps.sort()).toEqual(["assets/static-chunk.js.map"]);
    expect(result.keptModules).toEqual([
      "assets/dynamic-chunk.js",
      "assets/reexported-chunk.js",
      "assets/referenced.wasm",
      "assets/static-chunk.js",
      "assets/url-referenced-chunk.js",
      "index.js",
    ]);

    const remaining = (await readdir(serverDir, { recursive: true })).sort();
    expect(remaining).toContain("manifest.json");
    expect(remaining).toContain("index.js.map");
    expect(remaining).not.toContain(path.join("assets", "static-chunk.js.map"));
    expect(remaining).not.toContain(path.join("assets", "browser-worker.js"));
  });

  it("throws when the entrypoint is missing instead of deleting everything", async () => {
    const serverDir = await mkdtemp(path.join(tmpdir(), "prune-server-bundle-"));
    await write(serverDir, "other.js", [`export const x = 1;`]);

    await expect(pruneServerBundle({ entrypoint: "index.js", serverDir })).rejects.toThrow(
      /Entrypoint index\.js not found/,
    );
  });
});

async function write(root: string, relativePath: string, lines: string[]) {
  await writeFile(path.join(root, relativePath), lines.join("\n"));
}
