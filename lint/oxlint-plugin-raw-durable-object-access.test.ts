// iterate/no-raw-durable-object-binding-access: inside core/os/src, a raw `env.X.getByName(...)`
// is privileged platform authority, allowed only in Durable Objects, entrypoints, capability files,
// iterate-context.ts and the edge entry points. Rows are files in one temp project linted once by the real
// oxlint binary; `reported` says whether the rule flags that file.

import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test("raw env.X.getByName is allowed only in core/os's edge entry points and Durable Objects", () => {
  const rows = [
    {
      path: "core/os/src/new-route.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: true,
    },
    {
      path: "core/os/src/project/processor.ts",
      source: 'class P { f() { return this.env.ITERATE_CONTEXT.getByName("p:/"); } }',
      reported: true,
    },
    {
      path: "core/os/src/session-helper.ts",
      source: 'namespace.getByName("p:/");',
      reported: false,
    },
    {
      path: "core/os/src/worker.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: false,
    },
    {
      path: "core/os/src/mcp.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: false,
    },
    {
      path: "core/os/src/secret-oauth-callback.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: false,
    },
    {
      path: "core/os/src/integrations/slack.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: false,
    },
    {
      path: "core/os/src/iterate-context.ts",
      source: 'class E { f() { return this.env.ITERATE_CONTEXT.getByName("p:/"); } }',
      reported: false,
    },
    {
      path: "core/os/src/iterate-context-durable-object.ts",
      source: 'class D { f() { return this.env.ITERATE_CONTEXT.getByName("p:/"); } }',
      reported: false,
    },
    {
      path: "core/os/src/workspace/durable-object.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: false,
    },
    {
      path: "test/vitest/os-workers/support.ts",
      source: 'env.ITERATE_CONTEXT.getByName("p:/");',
      reported: false,
    },
    { path: "apps/agents/runtime/app.ts", source: 'env.SESSIONS.getByName("s");', reported: false },
  ];
  using fixture = createOxlintFixture({
    rules: { "iterate/no-raw-durable-object-binding-access": "error" },
  });
  for (const row of rows) fixture.write(row.path, `${row.source}\n`);

  const reported = new Set(
    fixture
      .diagnostics(rows.map((row) => row.path))
      .filter((diagnostic) => diagnostic.code === "iterate(no-raw-durable-object-binding-access)")
      .map((diagnostic) => diagnostic.filename),
  );
  expect(rows.filter((row) => reported.has(row.path)).map((row) => row.path)).toEqual(
    rows.filter((row) => row.reported).map((row) => row.path),
  );
});
