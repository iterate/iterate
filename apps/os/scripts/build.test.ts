import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { expect, test } from "vitest";

// apps/os is to become core/, which builds from a clone of itself: outside code may import it, it
// imports nothing outside. Until then these list what apps/os still reaches outside apps/os and
// packages/ (tasks/os-tooling-out-of-apps-os.md), so a new entry shows up in review.
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
      "scripts/lib/vite-build.ts",
      "scripts/lib/wrangler-config.ts",
    ]
  `);
});

// Every file's own imports, the tests' and the e2e suite's included, not only the build's.
test("apps/os imports only these files outside apps/os and packages/", () => {
  const repo = path.resolve(import.meta.dirname, "../../..");
  const files = execFileSync("git", ["ls-files", "apps/os/*.ts", "apps/os/*.tsx"], {
    cwd: repo,
    encoding: "utf8",
  }).split("\n");
  const outside = files.filter(Boolean).flatMap((file) =>
    [
      ...readFileSync(path.join(repo, file), "utf8").matchAll(
        /(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g,
      ),
    ]
      .map(([, specifier]) =>
        path.relative(repo, path.resolve(repo, path.dirname(file), specifier!)),
      )
      .filter((target) => !target.startsWith("apps/os/") && !target.startsWith("packages/"))
      // a specifier in a test's fixture source names no file
      .filter((target) => existsSync(path.join(repo, target)))
      .map((target) => `${target} <- ${file}`),
  );
  expect(outside.sort()).toMatchInlineSnapshot(`
    [
      "apps/dummy-petshop/src/memory-state.ts <- apps/os/__workers-tests__/support.ts",
      "apps/dummy-petshop/src/state.ts <- apps/os/__workers-tests__/identity.test.ts",
      "apps/dummy-petshop/src/state.ts <- apps/os/__workers-tests__/integrations.test.ts",
      "apps/telemetry/schemas/events.json <- apps/os/src/platform-hook.test.ts",
      "configs/default/worker.ts <- apps/os/src/project/default-template.test.ts",
      "configs/heartbeat/worker.ts <- apps/os/src/project/default-template.test.ts",
      "envs.ts <- apps/os/e2e/support/deployed-target.ts",
      "scripts/lib/vite-build.ts <- apps/os/scripts/build.ts",
      "scripts/lib/wrangler-config.ts <- apps/os/scripts/generate-wrangler-config.ts",
    ]
  `);
});
