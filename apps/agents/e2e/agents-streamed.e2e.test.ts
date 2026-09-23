// e2e/agents-streamed.e2e.test.ts — the streamed answer, in a file of its own: it waits out whole chunk
// windows (one of the suite's longest rows) and runs beside the other agent stories.
import { expect, test } from "vitest";
import { collector, freshCtx, readAll, until } from "../../os/e2e/support/client.ts";
import { openAgentItx } from "./support.ts";
import { ScriptedAi, onWorkersAi } from "./fixtures.ts";

test("streamed: the answer reaches a live subscriber as ephemeral chunk windows before it settles — never a stored row", async () => {
  const itx = await openAgentItx(freshCtx("agent-chunks"));
  const support = itx.cd("/agents/support");
  const ai = new ScriptedAi(["Four words, no code."]);
  await support.provide("itx.ai", ai);
  const windows = collector();
  await support.subscribe({
    name: "chunks",
    consumes: ["events.iterate.com/agent/llm-response-chunks"],
    target: windows.fn,
  });
  await itx.agents.create("/agents/support");
  const agent = itx.agents.get("/agents/support");
  await onWorkersAi(support);
  await agent.message("Say four words.");
  const log = await until("the settled request", async () => {
    const all = await readAll(support);
    return all.some((e) => e.type === "events.iterate.com/agent/llm-request-settled")
      ? all
      : undefined;
  });
  const requested = log.find((e) => e.type === "events.iterate.com/agent/llm-request-requested");
  await until("the chunk window", () => windows.invocations.length >= 1);
  // The fake answers whole, so its answer is ONE window: the request it belongs to, the provider's
  // chunk verbatim (Workers AI's `{ response }`), the first sequence number.
  expect(windows.types()).toEqual(["events.iterate.com/agent/llm-response-chunks"]);
  expect(windows.invocations[0]!.events[0]!.payload).toEqual({
    llmRequestOffset: requested.offset,
    chunks: [{ response: "Four words, no code." }],
    sequence: 0,
  });
  // Ephemeral: the durable log holds no chunk row, and the settlement carries the text.
  expect(log.filter((e) => e.type === "events.iterate.com/agent/llm-response-chunks")).toEqual([]);
  expect(
    log.find((e) => e.type === "events.iterate.com/agent/llm-request-settled")!.payload.result,
  ).toEqual({ status: "succeeded", text: "Four words, no code." });
});
