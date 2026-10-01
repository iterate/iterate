import { readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

// core/ builds from a clone of itself (core/AGENTS.md): outside code may import it, it imports
// nothing outside. The lint rule checks every file's imports as written; this follows the build's
// own, as esbuild resolves them.
test("the build reaches nothing outside core/", async () => {
  const repo = path.resolve(import.meta.dirname, "../../..");
  const { metafile } = await build({
    absWorkingDir: repo,
    entryPoints: ["core/os/vite.config.ts", "core/os/scripts/build.ts"],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    outdir: "unused",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  expect(Object.keys(metafile.inputs).filter((input) => !input.startsWith("core/"))).toEqual([]);
});

// A workspace package is outside too: core/lib is to become core/lib, and core/os keeps its
// own copies of the UI it uses (shadcn's and ours) instead of importing @iterate-com/ui.
test("core/os depends on only these workspace packages", () => {
  const manifest: Record<"dependencies" | "devDependencies", Record<string, string>> = JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
  );
  expect(
    Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter(([, version]) => version.startsWith("workspace:"))
      .map(([name]) => name),
  ).toMatchInlineSnapshot(`
    [
      "iterate",
    ]
  `);
});
