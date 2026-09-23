import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

// Dated-skip expiry guard (docs/testing.md#parked-tests-expire): a
// skip/fixme/todo marker that parks a KNOWN issue must carry
// `parked: <reason> — revisit by YYYY-MM-DD` near the marker. This test
// fails on any `revisit by` date in the past, printing the file and the
// parked reason, so parked tests get re-decided instead of rotting. Undated
// markers are for structural (platform-/env-gated) gates only, allowlisted
// below with a note. `test.fails` is not a marker: it runs, and turns red
// the moment the bug it pins is fixed. Deliberately dumb and fast — git
// ls-files plus a regex window, no AST.

const repoRoot = resolve(import.meta.dirname, "..");
const SELF = "lint/dated-skips.test.ts";

// Matches marker calls only; `skipIf`/`runIf` (conditional, structural by
// construction) deliberately do not match because of the trailing paren.
const MARKER = /\.(skip|fixme|todo)\(/;
const REVISIT = /revisit by (\d{4}-\d{2}-\d{2})/i;
// How many lines on each side of the marker may carry the parked/revisit
// comment.
const WINDOW = 6;

interface AllowedUndated {
  file: string;
  /** Distinctive substring near the marker, so entries survive line drift. */
  match: string;
  note: string;
}

const ALLOWED_UNDATED: AllowedUndated[] = [
  // -- Structural (env-gated): legitimately undated — the gate describes the
  // deployment under test, not a parked bug.
  {
    file: "apps/os/specs/mini-app.spec.ts",
    match: "the deployment routes projects by paths or not at all; this spec dials a subdomain",
    note: "env-gated: a preview routes projects by paths on its workers.dev origin; the mini-app spec dials `<project>.<hostname>`",
  },
  {
    file: "apps/os/specs/issuer-pages.spec.ts",
    match: "email-code sign-in is not configured",
    note: "env-gated: runs where the deployment offers email-code sign-in (login.emailCode), which a local worker does not",
  },
  {
    file: "apps/os/specs/auth.spec.ts",
    match: "This acceptance case needs the independently deployed Notes worker",
    note: "env-gated: needs NOTES_BASE_URL pointing at the independently deployed Notes worker (the os-next ↔ Notes acceptance case)",
  },
];

test("parked skip/fixme/todo markers carry an unexpired `revisit by` date", () => {
  // Same universe as CI lints: tracked files, node_modules excluded for free.
  const testFiles = execFileSync("git", ["ls-files"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(
      (file) =>
        /\.(test|spec)\.(ts|tsx|mts)$/.test(file) &&
        file !== SELF &&
        existsSync(resolve(repoRoot, file)),
    );

  const today = new Date().toISOString().slice(0, 10);
  const expired: string[] = [];
  const undated: string[] = [];
  const usedEntries = new Set<AllowedUndated>();

  for (const file of testFiles) {
    const lines = readFileSync(resolve(repoRoot, file), "utf8").split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (!MARKER.test(lines[index]!)) continue;
      const window = lines.slice(Math.max(0, index - WINDOW), index + WINDOW + 1).join("\n");
      const where = `${file}:${index + 1}`;

      const revisit = REVISIT.exec(window);
      if (revisit) {
        const date = revisit[1]!;
        const reason =
          /parked:\s*([^\n]+)/.exec(window)?.[1]?.trim() ??
          window
            .split("\n")
            .find((line) => REVISIT.test(line))!
            .trim();
        if (Number.isNaN(Date.parse(date))) {
          expired.push(`${where} — unparseable revisit date "${date}" — ${reason}`);
        } else if (date < today) {
          // Lexicographic compare is correct for YYYY-MM-DD.
          expired.push(`${where} — expired ${date} — ${reason}`);
        }
        continue;
      }

      const entry = ALLOWED_UNDATED.find(
        (candidate) => candidate.file === file && window.includes(candidate.match),
      );
      if (entry) {
        usedEntries.add(entry);
        continue;
      }
      undated.push(`${where} — ${lines[index]!.trim()}`);
    }
  }

  expect(
    expired,
    `Parked tests past their revisit-by date. Fix and un-park them, or renew the date with the reason re-argued:\n${expired.join("\n")}`,
  ).toEqual([]);

  expect(
    undated,
    `Undated skip/fixme/todo markers. Park known issues with \`parked: <reason> — revisit by YYYY-MM-DD\`; structural platform-/env-gates get an allowlist entry in ${SELF}:\n${undated.join("\n")}`,
  ).toEqual([]);

  const stale = ALLOWED_UNDATED.filter((entry) => !usedEntries.has(entry));
  expect(
    stale,
    `Allowlist entries in ${SELF} no longer match anything — the marker was fixed or moved; remove the entry:\n${stale.map((entry) => `${entry.file} — ${entry.match}`).join("\n")}`,
  ).toEqual([]);
});
