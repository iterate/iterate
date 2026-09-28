// Runs .oxlintrc.json's own overrides for the library rule (apps/os/src/library.ts), copied verbatim,
// over the fixtures below, linted once by the real oxlint binary.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test("a library file imports at runtime only what a userspace worker could, and any type", () => {
  const flagged = {
    "apps/os/src/library.ts": 'import { s } from "./stream/stream.ts";',
    "apps/os/src/library/a.ts": 'import { b } from "../context/built-ins.ts";',
    "apps/os/src/library/b.ts": 'export { s } from "../stream/stream.ts";',
    "apps/os/src/library/c.ts": 'import { readFileSync } from "node:fs";',
    "apps/os/src/library/d.ts": 'import { p } from "iterate/stream/processor";',
  };
  const allowed = {
    "apps/os/src/library/e.ts": 'import type { S } from "../stream/stream.ts";',
    "apps/os/src/library/f.ts": 'import { z } from "zod";',
    "apps/os/src/library/g.ts": 'import { print } from "iterate/expression";',
    "apps/os/src/library/h.ts": 'import { refuseUnlessOk } from "./connection.ts";',
    "apps/os/src/library/i.ts": 'import { buildLibrary } from "../library.ts";',
    "apps/os/src/library/j.ts": 'import { RpcTarget } from "capnweb";',
    "apps/os/src/library/k.ts": 'import { connectToMcp } from "./mcp.ts";',
    "apps/os/src/other.ts": 'import { s } from "./stream/stream.ts";',
  };
  const config = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "..", ".oxlintrc.json"), "utf8"),
  ) as { overrides: { files: string[] }[] };
  using fixture = createOxlintFixture({
    rules: {},
    overrides: config.overrides.filter((override) =>
      override.files.some((glob) => glob.startsWith("apps/os/src/library")),
    ),
  });
  const files = { ...flagged, ...allowed };
  for (const [path, source] of Object.entries(files)) fixture.write(path, `${source}\n`);

  const reported = fixture
    .diagnostics(Object.keys(files))
    .filter((diagnostic) => diagnostic.code === "eslint(no-restricted-imports)")
    .map((diagnostic) => diagnostic.filename);
  expect(reported.sort()).toEqual(Object.keys(flagged).sort());
});
