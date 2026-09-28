// The context tree's rows: every ancestor a row, `/` first, depth first in segment order; a
// segment no context sits at is a heading.
import { expect, test } from "vitest";
import { contextTreeRows } from "./context-tree.tsx";

test("paths become an indented tree with their ancestors, `/` first", () => {
  const rows = contextTreeRows(["/repos/config", "/agents/web/a", "/repos", "/agents-old"]);
  expect(rows.map((row) => [row.path, row.name, row.depth, row.context])).toEqual([
    ["/", "/", 0, true],
    ["/agents", "agents", 1, false],
    ["/agents/web", "web", 2, false],
    ["/agents/web/a", "a", 3, true],
    ["/agents-old", "agents-old", 1, true],
    ["/repos", "repos", 1, true],
    ["/repos/config", "config", 2, true],
  ]);
});

test("an empty registry is the root alone", () => {
  expect(contextTreeRows([])).toEqual([{ path: "/", name: "/", depth: 0, context: true }]);
});
