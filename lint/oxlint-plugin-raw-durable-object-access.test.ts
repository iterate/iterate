// iterate/no-raw-durable-object-binding-access: inside apps/os/src, a raw `env.X.getByName(...)`
// is privileged platform authority, allowed only in Durable Objects, entrypoints, capability files,
// iterate-context.ts and the edge doors. Rows are files in one temp project linted once by the real
// oxlint binary; `reported` says whether the rule flags that file.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";

test("raw env.X.getByName is allowed only in apps/os's doors and Durable Objects", () => {
  const rows = [
    {
      path: "apps/os/src/new-route.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: true,
    },
    {
      path: "apps/os/src/project/processor.ts",
      source: 'class P { f() { return this.env.ITERATE_CONTEXT.getByName("p:/"); } }',
      reported: true,
    },
    {
      path: "apps/os/src/session-helper.ts",
      source: 'namespace.getByName("p:/");',
      reported: false,
    },
    {
      path: "apps/os/src/worker.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: false,
    },
    {
      path: "apps/os/src/mcp.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: false,
    },
    {
      path: "apps/os/src/secret-oauth-callback.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: false,
    },
    {
      path: "apps/os/src/iterate-context.ts",
      source: 'class E { f() { return this.env.ITERATE_CONTEXT.getByName("p:/"); } }',
      reported: false,
    },
    {
      path: "apps/os/src/iterate-context-durable-object.ts",
      source: 'class D { f() { return this.env.ITERATE_CONTEXT.getByName("p:/"); } }',
      reported: false,
    },
    {
      path: "apps/os/src/workspace/durable-object.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: false,
    },
    {
      path: "apps/os/__workers-tests__/support.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: false,
    },
    { path: "apps/agents/runtime/app.ts", source: 'env.SESSIONS.getByName("s");', reported: false },
  ];
  using fixture = createOxlintFixture();
  for (const row of rows) fixture.write(row.path, `${row.source}\n`);

  expect(fixture.reportedPaths(rows.map((row) => row.path))).toEqual(
    rows.filter((row) => row.reported).map((row) => row.path),
  );
});

const repoRoot = resolve(import.meta.dirname, "..");

/** A temp project with the real plugin and the rule armed, linted by the real oxlint binary. */
function createOxlintFixture() {
  const root = mkdtempSync(join(tmpdir(), "iterate-oxlint-raw-durable-object-access-"));
  const configPath = join(root, ".oxlintrc.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [join(repoRoot, "lint", "oxlint-plugin-iterate.ts")],
      rules: { "iterate/no-raw-durable-object-binding-access": "error" },
    }),
  );
  return {
    [Symbol.dispose]() {
      rmSync(root, { force: true, recursive: true });
    },
    write(path: string, contents: string) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    },
    reportedPaths(paths: string[]) {
      const result = spawnSync(
        join(repoRoot, "node_modules", ".bin", "oxlint"),
        [...paths, "--config", configPath, "--threads", "1", "--format", "json"],
        { cwd: root, encoding: "utf8" },
      );
      const { diagnostics } = JSON.parse(result.stdout) as {
        diagnostics: { code: string; filename: string }[];
      };
      const reported = new Set(
        diagnostics
          .filter(
            (diagnostic) => diagnostic.code === "iterate(no-raw-durable-object-binding-access)",
          )
          .map((diagnostic) => diagnostic.filename),
      );
      return paths.filter((path) => reported.has(path));
    },
  };
}
