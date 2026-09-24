// e2e/agents-deployed.e2e.test.ts — the deployed-only agent rows: ONE real turn through Workers AI and the
// default model seeing an attached image. In a file of their own so their model round trips run beside
// the scripted stories instead of after them.
//
// THE MODEL BUDGET. The two OpenAI rows spend the preview AI Gateway's budget: rule
// `iterate-gateway-daily` on the preview account's gateway `default` — $30 a day, sliding, for every
// preview and every CI run together. Once it is spent the gateway refuses (429, code 2045, "Spend limit
// exceeded: rule 'iterate-gateway-daily'"), the agent pauses after three refusals, and these rows used
// to time out two minutes later with no word of why. On 2026-09-24 at 09:39 UTC it ran out: these two
// rows alone had spent $28.5 in the day (1,093 calls at ~$0.026), a busy CI morning plus back-to-back
// soaks. So: a refusal ends the wait at once with the refusal's own words; the budget's refusal is the
// rows' one known flake (createFlake — green and recorded, any other failure red); and the soak never
// runs them (scripts/e2e-soak.ts sets E2E_SOAK) — a soak's runs back to back spend what CI's own runs
// need. Raising the budget, or a cheaper model for these rows, is the owner's call.
import { expect, test } from "vitest";
import { createFlake } from "@iterate-com/shared/test-support/flake-test";
import { collector, freshCtx, readAll, until } from "../../os/e2e/support/client.ts";
import { deployedOnly, projectHostsAreLocal } from "../../os/e2e/support/project-host.ts";
import { RED_PNG_BASE64, assistantWords, configureModel } from "./fixtures.ts";
import { openAgentItx } from "./support.ts";

/** The gateway's refusal once the day's budget is spent — the OpenAI rows' one known flake. */
const GATEWAY_BUDGET_SPENT = /Spend limit exceeded: rule 'iterate-gateway-daily'/;
/** A row that spends the gateway's budget: deployed only, never in a soak, and green (recorded) when
 *  the budget refused it. */
const billed = createFlake(
  test.skipIf(projectHostsAreLocal() || process.env.E2E_SOAK === "1"),
  GATEWAY_BUDGET_SPENT,
  { timeoutMs: 150_000 },
);

billed(
  "DEPLOYED: one real turn through the default model, OpenAI's astra streamed from the Responses API on Cloudflare's billing — chunk windows fly, the settlement carries the usage",
  async () => {
    const itx = await openAgentItx(freshCtx("agent-real"));
    const support = itx.cd("/agents/support");
    const windows = collector();
    await support.subscribe({
      name: "chunks",
      consumes: ["events.iterate.com/agent/llm-response-chunks"],
      target: windows.fn,
    });
    await itx.agents.create("/agents/support");
    const agent = itx.agents.get("/agents/support");
    await agent.message(
      "Reply with the single word: pong, then one sentence about what a pong is. No code block.",
    );
    const log = await firstAnswer(support);
    expect(assistantWords(log).join("\n")).toMatch(/pong/i);
    // The stream: at least one window of Responses API events, in order, for the request that
    // answered (an earlier attempt the model refused streamed nothing, and the agent asked again).
    const settled = log.find(
      (e) =>
        e.type === "events.iterate.com/agent/llm-request-settled" &&
        e.payload.result?.status === "succeeded",
    );
    const requested = log.find((e) => e.offset === settled.payload.requestOffset);
    await until("the chunk windows", () => windows.invocations.length >= 1);
    const chunkEvents = windows.invocations.flatMap((i) => i.events);
    expect(chunkEvents.every((e) => e.payload.llmRequestOffset === requested.offset)).toBe(true);
    expect(chunkEvents.map((e) => e.payload.sequence)).toEqual(
      chunkEvents.map((_, index) => index),
    );
    const deltas = chunkEvents.flatMap((e) =>
      e.payload.chunks.filter((c: { type?: string }) => c.type === "response.output_text.delta"),
    );
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.map((c: { delta: string }) => c.delta).join("")).toMatch(/pong/i);
    // The cost, twice: on the settlement and as the report a feed shows the context's fullness by.
    expect(settled.payload.result).toMatchObject({
      status: "succeeded",
      usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
    });
    expect(
      log.find((e) => e.type === "events.iterate.com/agent/token-usage-reported")?.payload,
    ).toMatchObject({ model: "gpt-6-astra", maxContextTokens: 272_000 });
  },
  150_000,
);

billed(
  "DEPLOYED: the default model SEES an attached image — a red square is called red",
  async () => {
    const itx = await openAgentItx(freshCtx("agent-vision-real"));
    await itx.agents.create("/agents/support");
    const agent = itx.agents.get("/agents/support");
    await agent.message({
      message: "What colour is this image? Answer with one word, no code block.",
      files: [{ contentType: "image/png", filename: "square.png", data: RED_PNG_BASE64 }],
    });
    const words = assistantWords(await firstAnswer(itx.cd("/agents/support")));
    expect(words.join("\n")).toMatch(/red/i);
  },
  150_000,
);

deployedOnly(
  "DEPLOYED: a Workers AI model, pinned by agent/configured, sees the image too — no OpenAI key needed",
  async () => {
    const itx = await openAgentItx(freshCtx("agent-vision-cf"));
    const support = itx.cd("/agents/support");
    await itx.agents.create("/agents/support");
    const agent = itx.agents.get("/agents/support");
    await configureModel(support);
    await agent.message({
      message: "What colour is this image? Answer with one word, no code block.",
      files: [{ contentType: "image/png", filename: "square.png", data: RED_PNG_BASE64 }],
    });
    const words = assistantWords(await firstAnswer(support));
    expect(words.join("\n")).toMatch(/red/i);
  },
  150_000,
);

/** The agent's log once it has answered — or, once it has given up (paused: the model refused every
 *  attempt), a failure in the refusal's own words, at once rather than at the two-minute bound. */
async function firstAnswer(support: Parameters<typeof readAll>[0]) {
  const outcome = await until(
    "the assistant's answer",
    async () => {
      const all = await readAll(support);
      if (assistantWords(all).length > 0) return { all };
      const paused = all.find((e) => e.type === "events.iterate.com/agent/paused");
      return paused ? { paused, all } : undefined;
    },
    120_000,
  );
  if (!("paused" in outcome)) return outcome.all;
  const refusals = outcome.all
    .filter(
      (e) =>
        e.type === "events.iterate.com/agent/llm-request-settled" &&
        e.payload.result?.status === "failed",
    )
    .map((e) => String(e.payload.result.errorMessage));
  throw new Error(
    `the agent paused without answering (${String(outcome.paused.payload.reason)}); the model's last refusal: ${refusals.at(-1) ?? "none"}`,
  );
}
