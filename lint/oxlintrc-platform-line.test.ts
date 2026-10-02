// The SDK/platform line (core/lib/README.md#the-sdkplatform-line): under packages/, internal-packages/ and
// core/lib, nothing imports core/os; test/ is outside the rule. The rows run .oxlintrc.json's own
// overrides for `import-js/no-restricted-paths`, copied verbatim, over one temp project linted once
// by the real oxlint binary; `reported` says whether the rule flags that file.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test("nothing under packages/, internal-packages/ or core/lib imports core/os, whatever the import's shape", () => {
  const rows = [
    {
      path: "packages/dash/src/static.ts",
      source: 'import { x } from "../../../core/os/src/thing.ts";',
    },
    {
      path: "packages/dash/src/type.ts",
      source: 'import type { T } from "../../../core/os/src/thing.ts";',
    },
    {
      path: "packages/dash/src/reexport.ts",
      source: 'export { x } from "../../../core/os/src/thing.ts";',
    },
    { path: "packages/dash/src/star.ts", source: 'export * from "../../../core/os/src/thing.ts";' },
    {
      path: "packages/dash/src/dynamic.ts",
      source: 'await import("../../../core/os/src/thing.ts");',
    },
    {
      path: "packages/dash/src/dotted.ts",
      source: 'import { x } from "../../../core/os/./src/thing.ts";',
    },
    {
      path: "internal-packages/new-app/src/probe.ts",
      source: 'import { x } from "../../../core/os/src/thing.ts";',
    },
    {
      path: "core/lib/src/probe.ts",
      source: 'import { x } from "../../../core/os/src/thing.ts";',
    },
    {
      path: "packages/agents-app/src/probe.test.ts",
      source: 'import { s } from "../../../core/os/src/thing.ts";',
    },
    {
      path: "test/vitest/os/probe.e2e.test.ts",
      source: 'import { x } from "../../../core/os/src/thing.ts";',
      allowed: true,
    },
    { path: "core/os/src/own.ts", source: 'import { x } from "./thing.ts";', allowed: true },
    { path: "packages/dash/src/sdk.ts", source: 'import { x } from "iterate/api";', allowed: true },
  ];
  const config = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", ".oxlintrc.json"), "utf8"),
  ) as { overrides: { rules: Record<string, unknown> }[] };
  using fixture = createOxlintFixture({
    rules: {},
    jsPlugins: [
      {
        name: "import-js",
        specifier: createRequire(import.meta.url).resolve("eslint-plugin-import"),
      },
    ],
    overrides: config.overrides.filter((override) =>
      Object.hasOwn(override.rules, "import-js/no-restricted-paths"),
    ),
  });
  fixture.write("core/os/src/thing.ts", "export const x = 1;\nexport type T = number;\n");
  for (const row of rows) fixture.write(row.path, `${row.source}\n`);

  const reported = new Set(
    fixture
      .diagnostics(rows.map((row) => row.path))
      .filter((diagnostic) => diagnostic.code === "import-js(no-restricted-paths)")
      .map((diagnostic) => diagnostic.filename),
  );
  expect(rows.filter((row) => reported.has(row.path)).map((row) => row.path)).toEqual(
    rows.filter((row) => !row.allowed).map((row) => row.path),
  );
});
