// agent-events.test.ts — the os-next log through the shared reducer: `adaptContextRuns` turns the
// CONTEXT's runs (`context/run-requested` / `run-settled`, the request's offset as identity) into the
// script vocabulary apps/os's reducer folds (`capability-host/script-run-*`, an executionId the
// reducer links to the assistant's message), so a turn renders as one activity with its code step,
// the raw log stays as it is, and a bare reply's `reply:` script is filtered out of the feed.
import { describe, expect, test } from "vitest";
import { adaptContextRuns, reduceAgentFeed, scriptTrace, toAgentEvent } from "./agent-events.ts";

const PATH = "/agents/support";
const at = (offset: number, type: string, payload: unknown, idempotencyKey?: string) =>
  toAgentEvent(
    {
      offset,
      type,
      createdAt: new Date(1_700_000_000_000 + offset * 1000).toISOString(),
      payload,
      idempotencyKey,
    },
    PATH,
  )!;

/** One turn as the agent's own log lays it out: the person asks, the model answers (a codemode
 *  script, or a bare reply), the CONTEXT runs the script, the message goes out, the result comes
 *  back as the developer item. */
const turn = (kind: "run-requested" | "plain-response") => [
  at(1, "events.iterate.com/agent/created", { path: PATH }),
  at(2, "events.iterate.com/agents/context-added", { role: "system", content: "Be terse." }),
  at(3, "events.iterate.com/agents/context-added", {
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
  at(6, "events.iterate.com/agents/context-added", {
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
    `agent/${kind}@6`,
  ),
  // the visible message: the tag's prose sent directly, or the reply the `reply:` script sends
  at(
    9,
    "events.iterate.com/agents/web-message-sent",
    kind === "run-requested" ? { message: "Storing.", llmRequestOffset: 4 } : { message: "Done." },
  ),
  at(10, "events.iterate.com/context/run-settled", {
    requestOffset: 8,
    settlement: { status: "succeeded", result: { stored: true } },
  }),
  at(11, "events.iterate.com/agents/context-added", {
    role: "developer",
    content: "Your script returned: …",
    actor: { type: "script", requestOffset: 8 },
  }),
];

describe("adaptContextRuns — the context's runs in the reducer's vocabulary", () => {
  test("a request becomes script-run-requested with the executionId the reducer links to the assistant's message; its settlement and the developer item follow it by offset; the raw log is untouched", () => {
    const events = turn("run-requested");
    const adapted = adaptContextRuns(events);
    const byOffset = (offset: number) => adapted.find((e) => e.offset === offset)!;
    expect(byOffset(8)).toMatchObject({
      type: "events.iterate.com/capability-host/script-run-requested",
      payload: {
        executionId: "agent-output:6",
        code: expect.stringContaining("itx.kv.put"),
        expiresAt: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(byOffset(10)).toMatchObject({
      type: "events.iterate.com/capability-host/script-run-settled",
      payload: {
        executionId: "agent-output:6",
        settlement: { status: "succeeded", result: { stored: true } },
      },
    });
    expect(byOffset(11)).toMatchObject({
      payload: { actor: { type: "script", executionId: "agent-output:6" } },
    });
    expect(events.find((e) => e.offset === 8)!.type).toBe(
      "events.iterate.com/context/run-requested",
    );
    expect(adapted.filter((e) => e.type.startsWith("events.iterate.com/context/"))).toEqual([]);
  });

  test("a failed settlement gains the fields apps/os's strict schema wants — an interrupted run counts as having run", () => {
    const [, settled] = adaptContextRuns([
      at(
        8,
        "events.iterate.com/context/run-requested",
        { code: "async () => 1" },
        "agent/run-requested@6",
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

  test("through the reducer: the person's message, then one activity whose code step is the run, settled with its result; the trace finds code, settlement and the rendered result by the same id", () => {
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
    const trace = scriptTrace(adapted, "agent-output:6");
    expect(trace).toMatchObject({
      code: expect.stringContaining("itx.kv.put"),
      settlement: { value: { status: "succeeded", result: { stored: true } } },
    });
    expect(trace?.rendered).toBeDefined();
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
