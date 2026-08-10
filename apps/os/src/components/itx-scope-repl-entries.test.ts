import { expect, test } from "vitest";
import type { StreamEvent } from "iterate/processors";
import {
  deriveReplEntries,
  pendingRunVisibleInEntries,
  runErrorAlreadyJournaled,
  scriptBodyForDisplay,
  wrapReplScript,
} from "./itx-scope-repl-entries.ts";

test("wraps a plain body with the vars declaration and unwraps it for display", () => {
  const body = "return await itx.__describe()";
  const wrapped = wrapReplScript(body);
  expect(wrapped).toBe(
    [
      "async (itx) => {",
      // JS-safe on purpose: the no-emit fallback executes raw source, and
      // JSON.parse types vars `any` for the gate. See REPL_VARS_LINE.
      'const vars = JSON.parse("{}");',
      "return await itx.__describe()",
      "}",
    ].join("\n"),
  );
  expect(scriptBodyForDisplay(wrapped)).toBe(body);
});

test("a body declaring its own vars keeps it (specs prepend const vars = {…})", () => {
  const body = 'const vars = { projectId: "p1" };\n\nreturn vars.projectId';
  const wrapped = wrapReplScript(body);
  expect(wrapped).toBe(["async (itx) => {", body, "}"].join("\n"));
  expect(scriptBodyForDisplay(wrapped)).toBe(body);
});

test("scripts from other writers (agents, hand runScript) display verbatim", () => {
  const agentScript = "async (itx) => {\n  return 1;\n};";
  expect(scriptBodyForDisplay(agentScript)).toBe(agentScript);
  expect(scriptBodyForDisplay("async function run(itx) { return 1 }")).toBe(
    "async function run(itx) { return 1 }",
  );
});

test("derives running → success entries from requested/settled events", () => {
  const entries = deriveReplEntries([
    requested({ offset: 3, executionId: "run-1", code: wrapReplScript("return 1 + 1") }),
  ]);
  expect(entries).toMatchObject([
    { code: "return 1 + 1", executionId: "run-1", status: "running" },
  ]);

  const settledEntries = deriveReplEntries([
    requested({ offset: 3, executionId: "run-1", code: wrapReplScript("return 1 + 1") }),
    settled({ offset: 5, executionId: "run-1", settlement: { status: "succeeded", result: 2 } }),
  ]);
  expect(settledEntries).toMatchObject([
    // settledAtOffset is the entry's stable address — the same offset the
    // preamble's results rows carry for results.byOffset(n).
    {
      executionId: "run-1",
      requestedAtOffset: 3,
      result: 2,
      settledAtOffset: 5,
      status: "success",
    },
  ]);
});

test("a failed settlement renders the error; undefined results render as null", () => {
  const entries = deriveReplEntries([
    requested({ offset: 1, executionId: "boom", code: wrapReplScript("throw new Error('nope')") }),
    settled({
      offset: 2,
      executionId: "boom",
      settlement: {
        cancellation: "external-work-may-continue",
        error: "nope",
        executionMayHaveOccurred: true,
        failureKind: "runtime",
        phase: "execution",
        status: "failed",
      },
    }),
    requested({ offset: 3, executionId: "void", code: wrapReplScript("return undefined") }),
    settled({ offset: 4, executionId: "void", settlement: { status: "succeeded" } }),
  ]);
  expect(entries).toMatchObject([
    { error: "nope", executionId: "boom", status: "error" },
    { executionId: "void", result: null, status: "success" },
  ]);
});

test("entries sort by request offset and tolerate replayed duplicates", () => {
  const events = [
    requested({ offset: 10, executionId: "b", code: wrapReplScript("return 'b'") }),
    requested({ offset: 4, executionId: "a", code: wrapReplScript("return 'a'") }),
    settled({ offset: 12, executionId: "b", settlement: { status: "succeeded", result: "b" } }),
    // Reconnects replay from the start; the same events fold idempotently.
    requested({ offset: 4, executionId: "a", code: wrapReplScript("return 'a'") }),
  ];
  expect(deriveReplEntries(events)).toMatchObject([
    { executionId: "a", status: "running" },
    { executionId: "b", result: "b", status: "success" },
  ]);
});

test("the local pending row yields to the stream once its request lands", () => {
  const run = { afterOffset: 0, body: "return 1" };
  expect(pendingRunVisibleInEntries(deriveReplEntries([]), run)).toBe(false);

  const after = deriveReplEntries([
    requested({ offset: 1, executionId: "run-1", code: wrapReplScript("return 1") }),
  ]);
  expect(pendingRunVisibleInEntries(after, run)).toBe(true);
});

test("re-running the same snippet still shows a pending row (old runs cannot swallow it)", () => {
  // A settled earlier run of the identical code sits in history; the rerun's
  // submit-time anchor (afterOffset = newest buffered offset) means only a
  // NEWER request event can hide the local pending row.
  const history = deriveReplEntries([
    requested({ offset: 1, executionId: "run-1", code: wrapReplScript("return 1") }),
    settled({ offset: 2, executionId: "run-1", settlement: { status: "succeeded", result: 1 } }),
  ]);
  const rerun = { afterOffset: 2, body: "return 1" };
  expect(pendingRunVisibleInEntries(history, rerun)).toBe(false);

  const afterRerunRequested = deriveReplEntries([
    requested({ offset: 1, executionId: "run-1", code: wrapReplScript("return 1") }),
    settled({ offset: 2, executionId: "run-1", settlement: { status: "succeeded", result: 1 } }),
    requested({ offset: 3, executionId: "run-2", code: wrapReplScript("return 1") }),
  ]);
  expect(pendingRunVisibleInEntries(afterRerunRequested, rerun)).toBe(true);
});

test("the mutation-error line hides when the newest entry already carries it", () => {
  const entries = deriveReplEntries([
    requested({ offset: 1, executionId: "boom", code: wrapReplScript("oops") }),
    settled({
      offset: 2,
      executionId: "boom",
      settlement: {
        cancellation: "not-applicable",
        error: "Script failed the typecheck gate",
        executionMayHaveOccurred: false,
        failureKind: "typecheck",
        phase: "typecheck",
        status: "failed",
      },
    }),
  ]);
  expect(runErrorAlreadyJournaled(entries, "Script failed the typecheck gate")).toBe(true);
  expect(runErrorAlreadyJournaled(entries, "network went away")).toBe(false);
});

function requested(input: { code: string; executionId: string; offset: number }): StreamEvent {
  return event({
    offset: input.offset,
    payload: { code: input.code, executionId: input.executionId, expiresAt: Date.now() + 60_000 },
    type: "events.iterate.com/capability-host/script-run-requested",
  });
}

function settled(input: { executionId: string; offset: number; settlement: unknown }): StreamEvent {
  return event({
    offset: input.offset,
    payload: { executionId: input.executionId, settlement: input.settlement },
    type: "events.iterate.com/capability-host/script-run-settled",
  });
}

function event(input: { offset: number; payload: any; type: string }): StreamEvent {
  return {
    createdAt: new Date(1_700_000_000_000 + input.offset * 1_000).toISOString(),
    offset: input.offset,
    path: "/repl/user-1",
    payload: input.payload,
    type: input.type,
  } as StreamEvent;
}
