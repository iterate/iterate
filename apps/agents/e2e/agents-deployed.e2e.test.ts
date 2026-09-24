// e2e/agents-deployed.e2e.test.ts — the deployed-only agent rows: ONE real turn through Workers AI and the
// default model seeing an attached image. In a file of their own so their model round trips run beside
// the scripted stories instead of after them.
import { expect } from "vitest";
import { collector, freshCtx, readAll, until } from "../../os/e2e/support/client.ts";
import { deployedOnly } from "../../os/e2e/support/project-host.ts";
import { RED_PNG_BASE64, assistantWords, configureModel } from "./fixtures.ts";
import { openAgentItx } from "./support.ts";

deployedOnly(
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
    const log = await until(
      "the assistant's prose",
      async () => {
        const all = await readAll(support);
        return assistantWords(all).length > 0 ? all : undefined;
      },
      120_000,
    );
    expect(assistantWords(log).join("\n")).toMatch(/pong/i);
    // The stream: at least one window of Responses API events, in order, for this request.
    const requested = log.find((e) => e.type === "events.iterate.com/agent/llm-request-requested");
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
    const settled = log.find((e) => e.type === "events.iterate.com/agent/llm-request-settled");
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

deployedOnly(
  "DEPLOYED: the default model SEES an attached image — a red square is called red",
  async () => {
    const itx = await openAgentItx(freshCtx("agent-vision-real"));
    await itx.agents.create("/agents/support");
    const agent = itx.agents.get("/agents/support");
    await agent.message({
      message: "What colour is this image? Answer with one word, no code block.",
      files: [{ contentType: "image/png", filename: "square.png", data: RED_PNG_BASE64 }],
    });
    const words = await until(
      "the assistant's answer",
      async () => {
        const said = assistantWords(await readAll(itx.cd("/agents/support")));
        return said.length > 0 ? said : undefined;
      },
      120_000,
    );
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
    const words = await until(
      "the assistant's answer",
      async () => {
        const said = assistantWords(await readAll(support));
        return said.length > 0 ? said : undefined;
      },
      120_000,
    );
    expect(words.join("\n")).toMatch(/red/i);
  },
  150_000,
);
