// Rules restored after #2837 whose subject no retained code has: registered but not armed in
// .oxlintrc.json. Each row arms one rule on a temp file and names the lines it reports, so the rule
// still works the day its subject comes back. (contract-package-imports, itx-script-fn-self-contained
// and mechanical-class-impl have their own tests.)

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test.for([
  {
    rule: "no-direct-waituntil-import",
    source: [
      'import { waitUntil } from "cloudflare:workers";',
      'import * as cloudflareWorkers from "cloudflare:workers";',
      'import { WorkerEntrypoint } from "cloudflare:workers";',
    ],
    reportedLines: [1, 2],
  },
  {
    rule: "no-public-procedure",
    source: [
      "export const ping = publicProcedure.handler(() => 'pong');",
      "export const me = authProcedure.handler(() => 'me');",
    ],
    reportedLines: [1],
  },
])("$rule reports only the lines it names", ({ rule, source, reportedLines }) => {
  using fixture = createOxlintFixture(rule);
  fixture.write(`${source.join("\n")}\n`);
  expect(fixture.reportedLines()).toEqual(reportedLines);
});

const repoRoot = resolve(import.meta.dirname, "..");

/** A temp project with the real plugin and one rule armed, linted by the real oxlint binary. */
function createOxlintFixture(rule: string) {
  const root = mkdtempSync(join(tmpdir(), "iterate-oxlint-dormant-rules-"));
  const configPath = join(root, ".oxlintrc.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [join(repoRoot, "lint", "oxlint-plugin-iterate.ts")],
      rules: { [`iterate/${rule}`]: "error" },
    }),
  );
  return {
    [Symbol.dispose]() {
      rmSync(root, { force: true, recursive: true });
    },
    write(contents: string) {
      writeFileSync(join(root, "input.ts"), contents);
    },
    reportedLines() {
      const result = spawnSync(
        join(repoRoot, "node_modules", ".bin", "oxlint"),
        ["input.ts", "--config", configPath, "--threads", "1", "--format", "json"],
        { cwd: root, encoding: "utf8" },
      );
      const { diagnostics } = JSON.parse(result.stdout) as {
        diagnostics: { code: string; labels: { span: { line: number } }[] }[];
      };
      return diagnostics
        .filter((diagnostic) => diagnostic.code === `iterate(${rule})`)
        .map((diagnostic) => diagnostic.labels[0]!.span.line)
        .sort((a, b) => a - b);
    },
  };
}
