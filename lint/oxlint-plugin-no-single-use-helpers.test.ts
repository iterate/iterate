// Tests for iterate/no-single-use-helpers: a helper whose body is one line and which is used once
// belongs inline at its call site. An exported helper's uses are counted across the repository's
// files, so each row lints a temp git repository (untracked files count) with the real oxlint.

import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

test.for([
  {
    name: "reports a module-private helper used once",
    files: {
      "a.ts": `
        const failure = (message: string) => new Error(message);
        export function fail(message: string) { throw failure(message); }
      `,
    },
    reports: ["a.ts: failure is a single-use helper"],
  },
  {
    name: "reports an exported helper that one other file uses once, as rules/ once had to",
    files: {
      "errors.ts": `
        export class WorkerBuildFailedError extends Error {}
        export function workerBuildFailedError(failure: { message: string }) {
          return new WorkerBuildFailedError(failure.message);
        }
      `,
      "load.ts": `
        import { workerBuildFailedError } from "./errors.ts";
        export function load(loaded: { ok: boolean; failure: { message: string } }) {
          if (!loaded.ok) throw workerBuildFailedError(loaded.failure);
        }
      `,
    },
    reports: ["errors.ts: workerBuildFailedError is a single-use helper"],
  },
  {
    name: "leaves exported helpers used twice, re-exported or documented alone",
    files: {
      "helpers.ts": `
        export const twice = (value: string) => value.trim();
        export const renamed = (value: string) => value.trim();
        export { renamed as other };
        /** The form's label for a value, which the design system caps at 40 characters. */
        export const documented = (value: string) => value.slice(0, 40);
      `,
      "use.ts": `
        import { twice, other, documented } from "./helpers.ts";
        export const labels = [twice("a"), twice("b"), other("c"), documented("d")];
      `,
    },
    reports: [],
  },
])("$name", ({ files, reports }) => {
  using fixture = createOxlintFixture({ rules: { "iterate/no-single-use-helpers": "error" } });
  for (const [path, source] of Object.entries(files)) fixture.write(path, source);
  spawnSync("git", ["init", "--quiet"], { cwd: fixture.root });
  const messages = fixture
    .diagnostics(["."])
    .map((diagnostic) => `${diagnostic.filename}: ${diagnostic.message}`);
  expect(messages).toEqual(reports.map((opening) => expect.stringContaining(opening)));
});
