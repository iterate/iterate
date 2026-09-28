// e2e/agents-default-model.e2e.test.ts — THE DEFAULT MODEL'S TURN, twice over (docs/testing.md#real-model-rows).
//
// INTERCEPTED, in every run (PR previews, Main OS e2e, local, the soak): the agent's `itx.ai` is
// shadowed by a fake that plays the provider. The whole deployed runtime runs above it: the turn
// loop, the attachment turned into a vision input, the model call across the edge, the chunk windows, the
// settlement and the context report. The fake asserts what the runtime ASKED for (the model, the
// Responses API request, the image part, the AI Gateway options), and it costs nothing.
//
// REAL, once a day (os-real-model.yml, `E2E_REAL_MODELS=1`): the same turns against OpenAI's astra
// on Cloudflare's billing and a pinned Workers AI model. What only a provider can prove: that it
// accepts the request and answers the question. About $0.05 a run on the preview account's AI
// Gateway, whose daily spend cap every run shares.
import { expect, test } from "vitest";
import { collector, freshCtx, readAll, until } from "../../os/e2e/support/client.ts";
import { FakeAi, sseResponse } from "../../os/e2e/support/fake-ai.ts";
import { realModelOnly } from "../../os/e2e/support/project-host.ts";
import {
  RED_PNG_BASE64,
  WORKERS_AI_MODEL,
  answeredLog,
  assistantWords,
  configureModel,
} from "./fixtures.ts";
import { openAgentItx } from "./support.ts";

const PONG =
  "Reply with the single word: pong, then one sentence about what a pong is. No code block.";
const COLOUR = "What colour is this image? Answer with one word, no code block.";

test("one turn through the default model, the provider intercepted: the runtime asks for OpenAI's astra, streamed from the Responses API at low effort through the AI Gateway with the turn's metadata; chunk windows fly, the settlement carries the usage", async () => {
  const ctx = freshCtx("agent-default");
  const ai = responsesAi("pong. A pong is the answer a ping gets back.");
  const { log, chunkEvents } = await pongTurn(ctx, ai);
  expectStreamedTurn(log, chunkEvents);
  expect(ai.calls).toHaveLength(1);
  expect(ai.calls[0]).toMatchObject({
    model: "openai/gpt-6-astra",
    inputs: {
      stream: true,
      store: false,
      reasoning: { effort: "low", summary: "auto" },
      input: expect.arrayContaining([{ role: "user", content: PONG }]),
    },
    options: {
      returnRawResponse: true,
      gateway: {
        id: "default",
        skipCache: true,
        metadata: { projectId: ctx, streamPath: "/agents/support", context: "agent-turn" },
      },
    },
  });
}, 60_000);

test("the default model is SHOWN an attached image, the provider intercepted: the person's words and the stored pixels reach astra as one user input, the text and the PNG as a data: URL", async () => {
  const ai = responsesAi("Red.");
  expect(await colourTurn(freshCtx("agent-vision-default"), { ai })).toEqual(["Red."]);
  expect(ai.calls).toHaveLength(1);
  expect(ai.calls[0]).toMatchObject({ model: "openai/gpt-6-astra" });
  expect(
    (ai.calls[0]!.inputs.input as { role: string }[]).filter((item) => item.role === "user"),
  ).toEqual([
    {
      role: "user",
      content: [
        { type: "input_text", text: COLOUR },
        {
          type: "input_image",
          image_url: `data:image/png;base64,${RED_PNG_BASE64}`,
          detail: "auto",
        },
      ],
    },
  ]);
}, 60_000);

realModelOnly(
  "REAL: one turn through the default model, OpenAI's astra streamed from the Responses API on Cloudflare's billing — chunk windows fly, the settlement carries the usage",
  async () => {
    const { log, chunkEvents } = await pongTurn(freshCtx("agent-real"));
    expectStreamedTurn(log, chunkEvents);
  },
  150_000,
);

realModelOnly(
  "REAL: the default model SEES an attached image — a red square is called red",
  async () => {
    expect((await colourTurn(freshCtx("agent-vision-real"))).join("\n")).toMatch(/red/i);
  },
  150_000,
);

realModelOnly(
  "REAL: a Workers AI model, pinned by agent/configured, sees the image too — no OpenAI key needed",
  async () => {
    const words = await colourTurn(freshCtx("agent-vision-cf"), { model: WORKERS_AI_MODEL });
    expect(words.join("\n")).toMatch(/red/i);
  },
  150_000,
);

realModelOnly(
  "REAL: a fake lent to one agent answers that agent's turn and no other's — its sibling in the same project streams from the real model",
  async () => {
    const itx = await openAgentItx(freshCtx("agent-fake-one-context"));
    const faked = itx.cd("/agents/faked");
    const fake = responsesAi("pong, from the fake.");
    await faked.provide("itx.ai", fake);
    for (const path of ["/agents/faked", "/agents/real"]) {
      await itx.agents.create(path);
      await itx.agents.get(path).message(PONG);
    }
    expect(assistantWords(await answeredLog(faked, "the faked agent's prose"))).toEqual([
      "pong, from the fake.",
    ]);
    expect(fake.calls).toHaveLength(1);
    const real = assistantWords(
      await answeredLog(itx.cd("/agents/real"), "the real agent's prose"),
    );
    expect(real.join("\n")).toMatch(/pong/i);
    expect(real.join("\n")).not.toContain("from the fake");
  },
  150_000,
);

realModelOnly(
  "REAL: the person's interruption cuts a streaming answer from the real model short — settled cancelled with what had streamed, and the next turn answers",
  async () => {
    const itx = await openAgentItx(freshCtx("agent-interrupt-real"));
    const support = itx.cd("/agents/support");
    const windows = collector();
    await support.subscribe({
      name: "chunks",
      consumes: ["events.iterate.com/agent/llm-response-frame"],
      target: windows.fn,
    });
    await itx.agents.create("/agents/support");
    await itx.agents
      .get("/agents/support")
      .message("Count from 1 to 400, one number per line, and nothing else. No code block.");
    await until(
      "the answer's text is streaming",
      () =>
        windows.invocations.some((i) =>
          i.events.some((e: any) =>
            e.payload.chunks.some(
              (c: { type?: string }) => c.type === "response.output_text.delta",
            ),
          ),
        )
          ? true
          : undefined,
      120_000,
    );
    await support.append({
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "developer",
        content: "The user interrupted the in-progress response from the web chat.",
        actor: { type: "user" },
        llmRequestPolicy: { behaviour: "interrupt-current-request" },
      },
    });
    const settled = await until(
      "the interruption's settlement, then the next turn's",
      async () => {
        const results = (await readAll(support))
          .filter((e) => e.type === "events.iterate.com/agent/llm-request-settled")
          .map((e) => e.payload.result);
        return results.length === 2 ? results : undefined;
      },
      120_000,
    );
    expect(settled[0]).toMatchObject({
      status: "cancelled",
      reason: "interrupted-by-user-input",
      partialText: expect.stringMatching(/1\s+2\s+3/),
    });
    expect(settled[0].partialText).not.toMatch(/\b400\b/);
    expect(settled[1]).toMatchObject({ status: "succeeded" });
  },
  150_000,
);

/** The provider, played: every `itx.ai.run` the agent makes is answered as the Responses API
 *  streams, one SSE event per word and then the usage. */
const responsesAi = (reply: string) =>
  new FakeAi([
    () =>
      sseResponse([
        ...reply.split(/(?<= )/).map((delta) => ({ type: "response.output_text.delta", delta })),
        {
          type: "response.completed",
          response: { usage: { input_tokens: 2_083, output_tokens: 25 } },
        },
      ]),
  ]);

/** An agent at /agents/support on the default model asked for a pong, its chunk windows collected;
 *  `ai` shadows the provider. */
async function pongTurn(ctx: string, ai?: FakeAi) {
  const itx = await openAgentItx(ctx);
  const support = itx.cd("/agents/support");
  if (ai) await support.provide("itx.ai", ai);
  const windows = collector();
  await support.subscribe({
    name: "chunks",
    consumes: ["events.iterate.com/agent/llm-response-frame"],
    target: windows.fn,
  });
  await itx.agents.create("/agents/support");
  await itx.agents.get("/agents/support").message(PONG);
  const log = await answeredLog(support, "the assistant's prose");
  await until("the chunk windows", () => windows.invocations.length >= 1);
  return { log, chunkEvents: windows.invocations.flatMap((i) => i.events) };
}

/** What a streamed default-model turn leaves, whoever answered it: the answer; at least one window
 *  of Responses API events, in order, for the request that answered (an earlier attempt the model
 *  refused streamed nothing, and the agent asked again); the usage on the settlement and as the
 *  context report a feed shows the context's fullness by. */
function expectStreamedTurn(log: any[], chunkEvents: any[]) {
  expect(assistantWords(log).join("\n")).toMatch(/pong/i);
  const settled = log.find(
    (e) =>
      e.type === "events.iterate.com/agent/llm-request-settled" &&
      e.payload.result.status === "succeeded",
  );
  expect(
    chunkEvents.every((e) => e.payload.llmRequestOffset === settled.payload.requestOffset),
  ).toBe(true);
  expect(chunkEvents.map((e) => e.payload.sequence)).toEqual(chunkEvents.map((_, index) => index));
  const deltas = chunkEvents.flatMap((e) =>
    e.payload.chunks.filter((c: { type?: string }) => c.type === "response.output_text.delta"),
  );
  expect(deltas.length).toBeGreaterThan(0);
  expect(deltas.map((c: { delta: string }) => c.delta).join("")).toMatch(/pong/i);
  expect(settled.payload.result).toMatchObject({
    status: "succeeded",
    usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
  });
  expect(
    log.find((e) => e.type === "events.iterate.com/agent/token-usage-reported")?.payload,
  ).toMatchObject({ model: "gpt-6-astra", maxContextTokens: 272_000 });
}

/** An agent at /agents/support asked the colour of a red square; `model` pins one by
 *  agent/configured, `ai` shadows the provider. What the assistant said. */
async function colourTurn(ctx: string, { ai, model }: { ai?: FakeAi; model?: string } = {}) {
  const itx = await openAgentItx(ctx);
  const support = itx.cd("/agents/support");
  if (ai) await support.provide("itx.ai", ai);
  await itx.agents.create("/agents/support");
  if (model) await configureModel(support, model);
  await itx.agents.get("/agents/support").message({
    message: COLOUR,
    files: [{ contentType: "image/png", filename: "square.png", data: RED_PNG_BASE64 }],
  });
  return assistantWords(await answeredLog(support, "the assistant's answer"));
}
