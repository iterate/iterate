// agent-events.test.ts — the os-next log through the shared reducer: `adaptContextRuns` turns the
// CONTEXT's runs (`context/run-requested` / `run-settled`, the request's offset as identity) into the
// script vocabulary the platform's reducer folds (`capability-host/script-run-*`, an executionId the
// reducer links to the assistant's message — from the processor's `whileProcessing` stamp), so a
// turn renders as one activity with its code step, and a bare reply's `reply:` script is filtered out
// of the feed whether its activity settled on its own or at the idle boundary.
import { describe, expect, test } from "vitest";
import { adaptContextRuns, reduceAgentFeed, scriptTrace, toAgentEvent } from "./agent-events.ts";

const PATH = "/agents/support";
const at = (
  offset: number,
  type: string,
  payload: unknown,
  extra: { idempotencyKey?: string; source?: unknown } = {},
) =>
  toAgentEvent(
    {
      offset,
      type,
      createdAt: new Date(1_700_000_000_000 + offset * 1000).toISOString(),
      payload,
      ...extra,
    },
    PATH,
  )!;
/** The engine's stamp on an event the agent processor appended while processing offset 6. */
const byAgentWhile = (offset: number) => ({
  processor: { slug: "agent", version: "2", whileProcessing: { offset, type: "x" } },
});

/** One turn as the agent's own log lays it out: the person asks, the model answers (a codemode
 *  script, or a bare reply), the CONTEXT runs the script, the message goes out, the result comes
 *  back as the developer item. */
const turn = (kind: "run-requested" | "plain-response") => [
  at(1, "events.iterate.com/agent/created", { path: PATH }),
  at(2, "events.iterate.com/agent/context-added", { role: "system", content: "Be terse." }),
  at(3, "events.iterate.com/agent/context-added", {
    role: "user",
    content: "store 42",
    actor: { type: "user" },
  }),
  at(4, "events.iterate.com/agent/llm-request-requested", {
    model: "m",
    expiresAt: 9e12,
    triggerOffset: 3,
  }),
  at(5, "events.iterate.com/agent/llm-request-settled", {
    requestOffset: 4,
    result: { status: "succeeded", text: "ok" },
  }),
  at(6, "events.iterate.com/agent/context-added", {
    role: "assistant",
    llmRequestOffset: 4,
    content:
      kind === "run-requested"
        ? "Storing.\n<codemode status=\"Storing\">\nawait itx.kv.put('answer', '42')\n</codemode>"
        : "Done.",
  }),
  at(
    8,
    "events.iterate.com/context/run-requested",
    { code: "async (itx) => { await itx.kv.put('answer', '42'); return { stored: true } }" },
    { idempotencyKey: `agent/${kind}@6`, source: byAgentWhile(6) },
  ),
  // the visible message: the tag's prose sent directly, or the reply the `reply:` script sends
  at(
    9,
    "events.iterate.com/agent/web-message-sent",
    kind === "run-requested" ? { message: "Storing.", llmRequestOffset: 4 } : { message: "Done." },
  ),
  at(10, "events.iterate.com/context/run-settled", {
    requestOffset: 8,
    settlement: { status: "succeeded", result: { stored: true } },
  }),
  at(11, "events.iterate.com/agent/context-added", {
    role: "developer",
    content: "Your script returned: …",
    actor: { type: "script", requestOffset: 8 },
  }),
];

describe("adaptContextRuns — the context's runs in the reducer's vocabulary", () => {
  test("a request the agent appended while processing the assistant's item becomes script-run-requested with the id the reducer links to that item; its settlement takes the same id; a run nobody's processor asked for is its own offset", () => {
    const adapted = adaptContextRuns(turn("run-requested"));
    const byOffset = (offset: number) => adapted.find((e) => e.offset === offset)!;
    expect(byOffset(8)).toMatchObject({
      type: "events.iterate.com/capability-host/script-run-requested",
      payload: {
        executionId: "agent-output:6",
        requestOffset: 8,
        code: expect.stringContaining("itx.kv.put"),
        expiresAt: Date.parse(byOffset(8).createdAt) + 10 * 60_000,
      },
    });
    expect(byOffset(10)).toMatchObject({
      type: "events.iterate.com/capability-host/script-run-settled",
      payload: {
        executionId: "agent-output:6",
        requestOffset: 8,
        settlement: { status: "succeeded", result: { stored: true } },
      },
    });
    expect(adapted.filter((e) => e.type.startsWith("events.iterate.com/context/"))).toEqual([]);
    const [unasked] = adaptContextRuns([
      at(20, "events.iterate.com/context/run-requested", { code: "async () => 1" }),
    ]);
    expect(unasked!.payload).toMatchObject({ executionId: "run:20" });
  });

  test("a failed settlement gains the fields the platform's strict schema wants — an interrupted run counts as having run", () => {
    const [, settled] = adaptContextRuns([
      at(
        8,
        "events.iterate.com/context/run-requested",
        { code: "async () => 1" },
        {
          idempotencyKey: "agent/run-requested@6",
          source: byAgentWhile(6),
        },
      ),
      at(9, "events.iterate.com/context/run-settled", {
        requestOffset: 8,
        settlement: {
          status: "failed",
          error: "the context restarted",
          failureKind: "interrupted",
        },
      }),
    ]);
    expect(settled!.payload).toMatchObject({
      executionId: "agent-output:6",
      settlement: {
        status: "failed",
        error: "the context restarted",
        failureKind: "interrupted",
        phase: "execution",
        executionMayHaveOccurred: true,
      },
    });
  });

  test("through the reducer: the person's message, then one activity whose code step is the run, settled with its result; the trace finds code and settlement by the same id", () => {
    const adapted = adaptContextRuns(turn("run-requested"));
    const { items } = reduceAgentFeed(adapted, true);
    const activity = items.find((item) => item.kind === "activity");
    if (activity?.kind !== "activity") throw new Error("the turn folded to no activity");
    expect(activity.steps).toEqual([
      expect.objectContaining({ kind: "llm", llmRequestOffset: 4, status: "done" }),
      expect.objectContaining({
        kind: "code",
        executionId: "agent-output:6",
        status: "done",
        success: true,
        result: { stored: true },
      }),
    ]);
    expect(scriptTrace(adapted, "agent-output:6")).toMatchObject({
      code: expect.stringContaining("itx.kv.put"),
      settlement: { value: { status: "succeeded", result: { stored: true } } },
    });
  });

  test("a bare reply's `reply:` script shows as the message alone — its activity card is dropped, whether it settled on its own or at the idle boundary", () => {
    for (const idle of [true, false]) {
      const { items } = reduceAgentFeed(adaptContextRuns(turn("plain-response")), idle);
      expect(items.some((item) => item.kind === "activity")).toBe(false);
      expect(items.flatMap((item) => (item.kind === "assistant" ? [item.text] : []))).toEqual([
        "Done.",
      ]);
    }
  });
});
