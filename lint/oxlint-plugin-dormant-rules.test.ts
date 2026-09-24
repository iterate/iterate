// Rules restored after #2837 whose subject no retained code has: registered but not armed in
// .oxlintrc.json. Each row arms one rule on a temp file and names the lines it reports, so the rule
// still works the day its subject comes back. (contract-package-imports, itx-script-fn-self-contained
// and mechanical-class-impl have their own tests.)

import { expect, test } from "vitest";
import { createOxlintFixture } from "./oxlint-fixture.ts";

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
  using fixture = createOxlintFixture({ rules: { [`iterate/${rule}`]: "error" } });
  fixture.write("input.ts", `${source.join("\n")}\n`);
  const reported = fixture
    .diagnostics(["input.ts"])
    .filter((diagnostic) => diagnostic.code === `iterate(${rule})`)
    .map((diagnostic) => diagnostic.labels[0]!.span.line);
  expect(reported.sort((a, b) => a - b)).toEqual(reportedLines);
});
