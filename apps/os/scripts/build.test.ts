import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

// apps/os is to become core/, which builds from a clone of itself: outside code may import it, it
// imports nothing outside. Until then this lists what the build still reaches outside apps/os and
// packages/ (tasks/os-deployment-config-into-apps-os.md), so a new entry shows up in review.
test("the build reaches only these files outside apps/os and packages/", async () => {
  const repo = path.resolve(import.meta.dirname, "../../..");
  const { metafile } = await build({
    absWorkingDir: repo,
    entryPoints: ["apps/os/vite.config.ts", "apps/os/scripts/build.ts"],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    outdir: "unused",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  expect(
    Object.keys(metafile.inputs)
      .filter((input) => !input.startsWith("apps/os/") && !input.startsWith("packages/"))
      .sort(),
  ).toMatchInlineSnapshot(`
    [
      "envs.ts",
      "scripts/lib/vite-build.ts",
      "scripts/lib/wrangler-config.ts",
    ]
  `);
});
