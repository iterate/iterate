/**
 * EVAL (opt-in, pays for real LLM turns): after a codemode script returns
 * data, the model's NEXT script must reference the preamble `results` array —
 * `results[N].data` for small results, `await results[N].load(itx)` for large
 * ones — instead of re-fetching, re-pasting JSON, or reading the workspace
 * spill file. A live field test caught the model copying the fenced
 * `JSON.parse(await itx.workspace.readFile(...))` recipe instead of the
 * loader; these are the assertions that would have caught that prompt
 * regression (tasks/preamble-results-eval.md).
 *
 * Round 1 (the data-producing script) is journaled with the synthetic
 * provider fixture — deterministic, unpaid — and executes for real, settles,
 * and gets the real settlement render. Round 2 is a real user question via
 * `agent.ask` answered by the environment's configured LLM: the part under
 * eval. Model-choice assertions are single-sample and probabilistic, so this
 * file is NOT part of any default CI lane. Run it on demand, from `apps/os`:
 *
 *   doppler run --config dev -- env LLM_EVALS=1 pnpm e2e agent-preamble-results
 *   doppler run --config preview_3 -- env LLM_EVALS=1 pnpm e2e agent-preamble-results
 *
 * The `.llm.` filename marker is the cost dimension from docs/testing.md
 * (tests that pay for model turns); the env gate below is structural
 * (dated-skips: conditional skipIf, a property of the invocation, not a
 * parked bug).
 */
import { test } from "vitest";
import type { Stream } from "../../src/itx-api.generated.ts";
import { createTestProject } from "../test-support/create-test-project.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import {
  AGENT_CONTEXT_ADDED_TYPE,
  appendSyntheticProviderOutput,
  fencedAgentScript,
} from "./itx-test-support.ts";

const SCRIPT_REQUESTED_TYPE = "events.iterate.com/capability-host/script-run-requested";
const SCRIPT_SETTLED_TYPE = "events.iterate.com/capability-host/script-run-settled";
const LLM_REQUESTED_TYPE = "events.iterate.com/agent/llm-request-requested";
const LLM_SETTLED_TYPE = "events.iterate.com/agent/llm-request-settled";

/** Serialized-JSON gate between inline `.data` rows and `.load` rows —
 * mirrors INLINE_RESULT_PREAMBLE_LIMIT (capability-host-preamble.ts); the
 * tests assert their fixture data lands on the intended side of it. */
const INLINE_GATE_CHARS = 16_000;

const llmEvalsEnabled = process.env.LLM_EVALS === "1";

test.skipIf(!llmEvalsEnabled)(
  "after a small script result, the model's next script uses results[N].data",
  // Full LLM codemode loop, several turns — heavy-test ceiling.
  { timeout: 240_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "preamble-eval-data" });
    using agent = handle.agent("/agents/e2e-preamble-eval-data");
    await agent.create();

    // Round 1: a synthetic assistant turn whose script generates values at
    // RUNTIME — they exist only in the settlement, so the model cannot
    // re-derive them from its own script text, and re-generating produces a
    // wrong total the correctness assertion catches. 300 rows: comfortably
    // inside the 16k compact-JSON inline gate, but far past what a model can
    // sum in its head off the rendered JSON (a first cut used 24 rows and the
    // model simply mental-arithmetic'd the total without touching `results`).
    const { assistantContext } = await appendSyntheticProviderOutput(
      agent.stream,
      fencedAgentScript(`
        async (itx) => {
          const orders = Array.from({ length: 300 }, (_, i) => ({
            id: "ord-" + (i + 1),
            amountCents: 10000 + Math.floor(Math.random() * 89999),
          }));
          return { orders };
        }
      `),
    );
    const settlement = await waitForScriptSettlement(
      agent.stream,
      `agent-output:${assistantContext.offset}`,
    );
    expect(settlement).toMatchObject({ status: "succeeded" });
    const orders = (settlement as any).result.orders as Array<{ amountCents: number }>;
    const amounts = orders.map((order) => order.amountCents);
    const expectedTotal = amounts.reduce((sum, amount) => sum + amount, 0);
    // Fixture sanity: on the inline side of the gate, so the preamble row for
    // this result has `.data` (not `.load`) and the render says so.
    expect(JSON.stringify((settlement as any).result).length).toBeLessThan(INLINE_GATE_CHARS);
    const render = await agent.stream.waitForEvent({
      afterOffset: assistantContext.offset,
      eventTypes: [AGENT_CONTEXT_ADDED_TYPE],
      predicate: (event) =>
        event.payload?.role === "developer" &&
        String(event.payload.content ?? "").includes("results[0].data"),
      timeoutMs: 60_000,
    });

    // A result-bearing settlement triggers an autonomous feedback turn (the
    // codemode loop), and the model is free to dig into the result right
    // then — a first cut started the assertion window after the loop went
    // quiet and watched the model answer round 2 from work it had already
    // done. The window therefore opens AT THE RENDER: every script written
    // after the model saw "your script returned …" counts, whichever turn
    // it lands in. The quiet-wait still separates the rounds so the ask's
    // reply correlates cleanly.
    await waitForQuietAgent(agent.stream, { timeoutMs: 120_000 });

    // Round 2 — the real product surface and a real LLM turn. The question
    // needs the data but does not mention `results`: whether the model
    // reaches for the preamble is exactly what the prompt must teach.
    const reply = await agent.ask({
      message:
        "What is the exact sum of the amountCents values across all the orders " +
        "your script returned? Reply with just the number.",
      timeoutMs: 150_000,
    });

    const scripts = await scriptsBetween(agent.stream, render.offset, reply.offset);
    expect(scripts.length).toBeGreaterThan(0);
    // THE eval: whichever script consumes the result reaches it through the
    // preamble array. (Not necessarily scripts[0] — the loop may narrate or
    // update its summary first.)
    expect(scripts).toContainEqual(expect.stringMatching(/results\[\d+\]\.data/));
    const joined = scripts.join("\n");
    // Anti-patterns: reading the (nonexistent here) spill file, or
    // re-generating the data — this scenario's version of re-fetching.
    expect(joined).not.toMatch(/workspace\.readFile/);
    expect(joined).not.toMatch(/Math\.random/);
    // Re-pasting the JSON between turns is what the preamble exists to kill.
    // Three independent 5-digit literals colliding by chance is negligible.
    const repastedAmounts = amounts.filter((amount) =>
      new RegExp(`\\b${amount}\\b`).test(joined),
    ).length;
    expect(repastedAmounts).toBeLessThan(3);

    // And the answer is actually right — computed from the data, not vibes.
    const replyText = String(reply.payload?.message ?? "").replace(/[,\s]/g, "");
    expect(replyText).toContain(String(expectedTotal));
  },
);

test.skipIf(!llmEvalsEnabled)(
  "after a large script result, the model's next script uses await results[N].load(itx)",
  // Full LLM codemode loop, several turns — heavy-test ceiling.
  { timeout: 240_000 },
  async ({ expect }) => {
    await using handle = await createTestProject({ slugPrefix: "preamble-eval-load" });
    using agent = handle.agent("/agents/e2e-preamble-eval-load");
    await agent.create();

    // Round 1: over the 16k compact-JSON gate (a `.load` preamble row) AND
    // over the ~30k render limit, so the result also spills to a workspace
    // file — the render's secondary footnote is the exact readFile temptation
    // the field test caught the model copying. The secret is buried past the
    // 3-item array preview, so answering REQUIRES loading the full result.
    const { assistantContext } = await appendSyntheticProviderOutput(
      agent.stream,
      fencedAgentScript(`
        async (itx) => {
          const secret = crypto.randomUUID();
          const rows = Array.from({ length: 2500 }, (_, i) => ({
            id: i,
            code: "c-" + ((i * 7919) % 104729),
            ...(i === 1234 ? { secret } : {}),
          }));
          return { rows };
        }
      `),
    );
    const settlement = await waitForScriptSettlement(
      agent.stream,
      `agent-output:${assistantContext.offset}`,
    );
    expect(settlement).toMatchObject({ status: "succeeded" });
    const rows = (settlement as any).result.rows as Array<{ secret?: string }>;
    const secret = rows[1234]!.secret!;
    expect(secret).toMatch(/^[0-9a-f-]{36}$/);
    // Fixture sanity: on the `.load` side of the gate.
    expect(JSON.stringify((settlement as any).result).length).toBeGreaterThan(INLINE_GATE_CHARS);
    const render = await agent.stream.waitForEvent({
      afterOffset: assistantContext.offset,
      eventTypes: [AGENT_CONTEXT_ADDED_TYPE],
      predicate: (event) =>
        event.payload?.role === "developer" &&
        String(event.payload.content ?? "").includes("results[0].load(itx)"),
      timeoutMs: 60_000,
    });

    // Window opens at the render — see the inline case for why (the loop's
    // feedback turn may load the result before the user asks anything).
    await waitForQuietAgent(agent.stream, { timeoutMs: 120_000 });

    const reply = await agent.ask({
      message:
        "One of the rows in the data your script returned has a `secret` field. " +
        "Reply with its exact value and nothing else.",
      timeoutMs: 150_000,
    });

    const scripts = await scriptsBetween(agent.stream, render.offset, reply.offset);
    expect(scripts.length).toBeGreaterThan(0);
    // THE eval: the typed loader, not the workspace spill file the render's
    // footnote also mentions (the field-test regression was the model copying
    // a readFile recipe instead of the loader).
    expect(scripts).toContainEqual(expect.stringMatching(/await results\[\d+\]\.load\(itx\)/));
    expect(scripts.join("\n")).not.toMatch(/workspace\.readFile/);

    expect(String(reply.payload?.message ?? "")).toContain(secret);
  },
);

// ---------------------------------------------------------------------------
// helpers

/** The settlement of one known execution — waited on, then returned. */
async function waitForScriptSettlement(stream: Stream, executionId: string) {
  const event = await stream.waitForEvent({
    afterOffset: 0,
    eventTypes: [SCRIPT_SETTLED_TYPE],
    predicate: (candidate: any) => candidate.payload?.executionId === executionId,
    timeoutMs: 90_000,
  });
  return (event as any).payload.settlement as { status: string; result?: unknown };
}

/**
 * Wait for the agent's codemode loop to go quiet — every llm request and
 * script run settled, and the (filtered) stream head unchanged across two
 * consecutive 3s-apart reads — then return the stream's last offset as the
 * cursor for the next round's assertion window.
 */
async function waitForQuietAgent(stream: Stream, input: { timeoutMs: number }): Promise<number> {
  let previousHead = -1;
  let quietReads = 0;
  await waitForCondition(
    async () => {
      const events: any[] = await stream.getEvents({
        eventTypes: [
          LLM_REQUESTED_TYPE,
          LLM_SETTLED_TYPE,
          SCRIPT_REQUESTED_TYPE,
          SCRIPT_SETTLED_TYPE,
        ],
        limit: 500,
      });
      const openLlmRequest = events.some(
        (event) =>
          event.type === LLM_REQUESTED_TYPE &&
          !events.some(
            (settled) =>
              settled.type === LLM_SETTLED_TYPE && settled.payload?.requestOffset === event.offset,
          ),
      );
      const openScript = events.some(
        (event) =>
          event.type === SCRIPT_REQUESTED_TYPE &&
          !events.some(
            (settled) =>
              settled.type === SCRIPT_SETTLED_TYPE &&
              settled.payload?.executionId === event.payload?.executionId,
          ),
      );
      const head = events.at(-1)?.offset ?? 0;
      quietReads = !openLlmRequest && !openScript && head === previousHead ? quietReads + 1 : 0;
      previousHead = head;
      return quietReads >= 2;
    },
    {
      description: "the agent's codemode loop to go quiet",
      intervalMs: 3_000,
      timeoutMs: input.timeoutMs,
    },
  );
  // The filtered head is a valid cursor: it is at or past every round-1
  // script request (their settlements and the loop's llm settlements come
  // later), and round-2 scripts can only land after the user's next message.
  return previousHead;
}

/** The code of every script the agent requested strictly inside the offset
 * window — the scripts it wrote in response to the round-2 question, up to
 * the visible reply (post-reply loop-feedback scripts are excluded so the
 * window is deterministic). */
async function scriptsBetween(
  stream: Stream,
  afterOffset: number,
  beforeOffset: number,
): Promise<string[]> {
  const events: any[] = await stream.getEvents({
    afterOffset,
    eventTypes: [SCRIPT_REQUESTED_TYPE],
    limit: 100,
  });
  return events
    .filter((event) => event.offset < beforeOffset)
    .map((event) => String(event.payload?.code ?? ""));
}
