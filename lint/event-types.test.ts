import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test } from "vitest";

// Event-type guard (packages/iterate/README.md#event-types). An event type is a plain string, so a
// stale or misspelled type compiles, and a subscriber that names it simply never hears from it.
// This test reads every `events.iterate.com/…` literal in a tracked file and fails on a retired
// name, a namespace outside the rules, an event that is not kebab-case, or a third segment.
// Deliberately dumb and fast: git grep plus a regex, no AST. A template (`events.iterate.com/${x}`)
// or a placeholder (`<namespace>`, `…`, `*`) is not a literal and is skipped.

const repoRoot = resolve(import.meta.dirname, "..");

/** The namespaces the rules allow: `itx`, the singular domain namespaces, integrations, `test`. */
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
  // integrations, named after themselves
  "chrome",
  "email",
  // the agent UI's in-memory view of `itx/run-*`, never written to a log
  "capability-host",
  // an example the Agents composer offers; no contract defines it
  "note",
  "test",
]);

/** Every renamed type, old → new. The durable core types among them are also refused at the append
 *  boundary (apps/os/src/stream/retired-event-types.ts). */
const RETIRED: Record<string, string> = {
  "stream/created": "itx/created",
  "stream/woken": "itx/woken",
  "stream/paused": "itx/paused",
  "stream/resumed": "itx/resumed",
  "context/aborted": "itx/aborted",
  "context/facet-aborted": "itx/facet-aborted",
  "context/child-created": "itx/descendant-created",
  "context/run-requested": "itx/run-requested",
  "context/run-settled": "itx/run-settled",
  "stream/subscription-configured": "itx/subscription-configured",
  "stream/subscription-delivery-halted": "itx/subscription-delivery-halted",
  "stream/subscription-delivery-resumed": "itx/subscription-delivery-resumed",
  "stream/append-scheduled": "itx/schedule-set",
  "stream/append-schedule-cancelled": "itx/schedule-cancelled",
  "stream/append-schedule-completed": "itx/schedule-fired",
  "stream/append-schedule-failed": "itx/schedule-failed",
  "stream/trace/alarm": "itx/alarm-trace",
  "live-state/changed": "itx/live-state-changed",
  "rpc-stub/attached": "itx/rpc-stub-attached",
  "rpc-stub/detached": "itx/rpc-stub-detached",
  "fetch-route/configured": "itx/fetch-route-configured",
  "ingress-route/configured": "itx/fetch-route-configured",
  "project/ingress-configured": "itx/ingress-configured",
  "project/hostname-add-answered": "project/hostname-add-settled",
  "organization/project-created": "organization/project-added",
  "agent/llm-response-chunks": "agent/llm-response-frame",
  "voice-agent/provider-error": "voice-agent/provider-error-reported",
  "voice-agent/utterance-transcript": "voice-agent/utterance-transcribed",
  "voice-agent/answer-transcript": "voice-agent/answer-transcribed",
  "voice-agent/thinking": "voice-agent/thinking-added",
  "voice-agent/commentary": "voice-agent/commentary-added",
  "flakes/created": "flake-dashboard/created",
  "flakes/run-recorded": "flake-dashboard/run-recorded",
  "flakes/transition-proposed": "flake-dashboard/transition-proposed",
  "notes/added": "note/added",
  "account/test": "test/fact-appended",
  "test/tick": "test/ticked",
  "config-ping": "test/ping-sent",
  "config-pong": "test/pong-sent",
  "counter/ticked": "test/counter-ticked",
  "counter/milestone": "test/counter-milestone-reached",
};

/** Files that spell retired names on purpose: this guard and the append boundary's refusal map. */
const RETIRED_NAMES_ALLOWED_IN = new Set([
  "lint/event-types.test.ts",
  "apps/os/src/stream/retired-event-types.ts",
  "apps/os/src/stream/retired-event-types.test.ts",
]);

/** One literal: its namespace, its event (absent when none follows), any further segments. */
const LITERAL =
  /events\.iterate\.com\/([A-Za-z0-9_-]*)(?:\/([A-Za-z0-9_-]*))?((?:\/[A-Za-z0-9_-]+)*)/g;
/** An event segment: lowercase kebab-case; a trailing `-` is a family prefix (`itx/run-`). */
const EVENT = /^[a-z0-9]+(?:-[a-z0-9]+)*-?$/;

test("no tracked file spells a retired event type", () => {
  const found: string[] = [];
  for (const { file, line, text } of literalLines()) {
    if (RETIRED_NAMES_ALLOWED_IN.has(file)) continue;
    for (const [old, renamed] of Object.entries(RETIRED))
      if (new RegExp(`events\\.iterate\\.com/${old}(?![A-Za-z0-9_-])`).test(text))
        found.push(`${file}:${line}: events.iterate.com/${old} was renamed to ${renamed}`);
  }
  expect(found).toEqual([]);
});

test("every events.iterate.com literal is `<namespace>/<event>` under an allowed namespace", () => {
  const found: string[] = [];
  for (const { file, line, text } of literalLines()) {
    if (RETIRED_NAMES_ALLOWED_IN.has(file)) continue;
    for (const match of text.matchAll(LITERAL)) {
      const [literal, namespace, event, rest] = match;
      if (namespace === "") continue; // a template or a placeholder
      const at = `${file}:${line}: ${literal}`;
      if (!NAMESPACES.has(namespace!)) found.push(`${at}: namespace "${namespace}" is not allowed`);
      else if (event === undefined) {
        if (text[match.index + literal.length] !== "$") found.push(`${at}: no event segment`);
      } else if (rest) found.push(`${at}: a type has two segments, never three`);
      else if (event !== "" && !EVENT.test(event))
        found.push(`${at}: "${event}" is not lowercase kebab-case`);
    }
  }
  expect(found).toEqual([]);
});

test("the guard's own tables: every rename lands on an allowed, current name", () => {
  for (const [old, renamed] of Object.entries(RETIRED)) {
    const [namespace, event, ...rest] = renamed.split("/");
    expect({ old, namespace: NAMESPACES.has(namespace!), event: EVENT.test(event!), rest }).toEqual(
      { old, namespace: true, event: true, rest: [] },
    );
    expect({ old, renamedIsRetired: renamed in RETIRED }).toEqual({ old, renamedIsRetired: false });
  }
});

function literalLines(): { file: string; line: string; text: string }[] {
  const output = execFileSync(
    "git",
    ["grep", "-n", "-I", "--full-name", "-F", "events.iterate.com/", "--", ".", ":!pnpm-lock.yaml"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [, file, line, text] = /^(.+?):(\d+):(.*)$/.exec(row)!;
      return { file: file!, line: line!, text: text! };
    });
}
