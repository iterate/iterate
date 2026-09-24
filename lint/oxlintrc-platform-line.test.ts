// The SDK/platform line (packages/iterate/README.md#the-sdkplatform-line): outside apps/os, nothing imports
// apps/os except its two test harnesses. The rows run .oxlintrc.json's own overrides for
// `import-js/no-restricted-paths`, copied verbatim, over one temp project linted once by the real
// oxlint binary; `reported` says whether the rule flags that file.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test("outside apps/os, only apps/os's test harnesses are importable, whatever the import's shape", () => {
  const rows = [
    { path: "apps/dash/src/static.ts", source: 'import { x } from "../../os/src/thing.ts";' },
    { path: "apps/dash/src/type.ts", source: 'import type { T } from "../../os/src/thing.ts";' },
    { path: "apps/dash/src/reexport.ts", source: 'export { x } from "../../os/src/thing.ts";' },
    { path: "apps/dash/src/star.ts", source: 'export * from "../../os/src/thing.ts";' },
    { path: "apps/dash/src/dynamic.ts", source: 'await import("../../os/src/thing.ts");' },
    { path: "apps/dash/src/dotted.ts", source: 'import { x } from "../../os/./src/thing.ts";' },
    { path: "apps/new-app/src/probe.ts", source: 'import { x } from "../../os/src/thing.ts";' },
    {
      path: "packages/iterate/src/probe.ts",
      source: 'import { x } from "../../../apps/os/src/thing.ts";',
    },
    {
      path: "apps/agents/e2e/fixture.e2e.test.ts",
      source: 'import { f } from "../../os/e2e/fixture.ts";',
    },
    {
      path: "apps/agents/e2e/probe.e2e.test.ts",
      source: 'import { c } from "../../os/e2e/support/client.ts";',
      allowed: true,
    },
    {
      path: "apps/agents/__workers-tests__/probe.test.ts",
      source: 'import { s } from "../../os/__workers-tests__/support.ts";',
      allowed: true,
    },
    { path: "apps/os/src/own.ts", source: 'import { x } from "./thing.ts";', allowed: true },
    { path: "apps/dash/src/sdk.ts", source: 'import { x } from "iterate/api";', allowed: true },
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
  fixture.write("apps/os/src/thing.ts", "export const x = 1;\nexport type T = number;\n");
  fixture.write("apps/os/e2e/fixture.ts", "export const f = 1;\n");
  fixture.write("apps/os/e2e/support/client.ts", "export const c = 1;\n");
  fixture.write("apps/os/__workers-tests__/support.ts", "export const s = 1;\n");
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
