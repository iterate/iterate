// The core boundary (core/AGENTS.md): core/ builds from a clone of itself, so nothing in it imports
// outside it. Outside code may import core. The rows run .oxlintrc.json's own overrides for
// `import-js/no-restricted-paths`, copied verbatim, over one temp project linted once by the real
// oxlint binary; `reported` says whether the rule flags that file.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test("nothing in core/ imports outside core/ but npm packages", () => {
  const rows = [
    { path: "core/os/scripts/build.ts", source: 'import { x } from "../../../scripts/lib/x.ts";' },
    { path: "core/os/src/envs.ts", source: 'import { x } from "../../../envs.ts";' },
    {
      path: "core/os/src/shared.ts",
      source: 'import { x } from "../../../packages/shared/src/x.ts";',
    },
    { path: "core/os/src/dash.ts", source: 'export { x } from "../../../apps/dash/src/x.ts";' },
    { path: "core/os/src/dynamic.ts", source: 'await import("../../../test/helpers/x.ts");' },
    {
      path: "core/lib/src/cli/config.ts",
      source: 'import { x } from "../../../../packages/shared/src/x.ts";',
    },
    {
      path: "core/os/src/template.test.ts",
      source: 'import { x } from "../../../configs/voice/voice.ts";',
    },
    {
      path: "core/os/src/sdk.ts",
      source: 'import { x } from "../../lib/src/lib.ts";',
      allowed: true,
    },
    { path: "core/os/src/npm.ts", source: 'import { z } from "zod";', allowed: true },
    {
      path: "scripts/lib/outside.ts",
      source: 'import { x } from "../../core/os/src/thing.ts";',
      allowed: true,
    },
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
  // the rule only judges an import it can resolve, so every target exists
  for (const target of [
    "scripts/lib/x.ts",
    "envs.ts",
    "packages/shared/src/x.ts",
    "apps/dash/src/x.ts",
    "test/helpers/x.ts",
    "configs/voice/voice.ts",
    "core/lib/src/lib.ts",
    "core/os/src/thing.ts",
  ])
    fixture.write(target, "export const x = 1;\n");
  fixture.write("node_modules/zod/package.json", '{ "name": "zod", "main": "index.js" }\n');
  fixture.write("node_modules/zod/index.js", "export const z = 1;\n");
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
