import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

// Every `events.iterate.com/…` literal in a tracked file names `<namespace>/<event>`: an allowed
// namespace, a lowercase kebab-case event, never a third segment. The rules:
// packages/iterate/README.md#event-types. A template (`events.iterate.com/${x}`) or a placeholder
// (`<namespace>`, `…`, `*`) is skipped.

const NAMESPACES = new Set([
  "itx",
  "account",
  "organization",
  "project",
  "repo",
  "workspace",
  "secret",
  "agent",
  "voice-agent",
  "flake-dashboard",
  "chrome",
  "email",
  "capability-host",
  "note",
  "test",
]);

/** Namespace, the `/<event>` after it, the event, and any further segments. */
const LITERAL =
  /events\.iterate\.com\/([A-Za-z0-9_-]*)(\/([A-Za-z0-9_-]*))?((?:\/[A-Za-z0-9_-]+)*)/g;
/** A trailing `-` is a family prefix (`itx/run-`). */
const EVENT = /^[a-z0-9]+(?:-[a-z0-9]+)*-?$/;

test("every events.iterate.com literal is `<namespace>/<event>` under an allowed namespace", () => {
  const rows = execFileSync(
    "git",
    ["grep", "-n", "-I", "--full-name", "-F", "events.iterate.com/", "--", ".", ":!pnpm-lock.yaml"],
    { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const found: string[] = [];
  for (const row of rows.split("\n").filter(Boolean)) {
    const [, at, text] = /^(.+?:\d+):(.*)$/.exec(row)!;
    for (const match of text!.matchAll(LITERAL)) {
      const [literal, namespace, slashEvent, event, rest] = match;
      if (namespace === "") continue;
      if (!NAMESPACES.has(namespace!)) found.push(`${at}: ${literal}: namespace not allowed`);
      else if (!slashEvent) {
        if (text![match.index + literal.length] !== "$") found.push(`${at}: ${literal}: no event`);
      } else if (rest) found.push(`${at}: ${literal}: a third segment`);
      else if (event && !EVENT.test(event)) found.push(`${at}: ${literal}: not kebab-case`);
    }
  }
  expect(found).toEqual([]);
});
