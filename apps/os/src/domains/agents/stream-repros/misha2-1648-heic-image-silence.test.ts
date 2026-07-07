// Repro for prod stream misha2 /agents/1648 (offsets 3008–3014): the user
// sent "Who's this" with an iPhone photo (image/heic). The openai-ws provider
// forwarded it to OpenAI as a native input_image part; OpenAI rejected the
// whole request with a 400 ("The image data you provided does not represent a
// valid image... supported: jpeg/png/gif/webp") and the agent went silent —
// no reply, no error, nothing.
//
// The fixture is the real event journal up to offset 3007 (just before the
// bad message), shrunk at dump time — noted per the fix-stream skill:
// - dropped events.iterate.com/openai-ws/llm-response-chunk (2670 bulk events
//   no processor under test consumes)
// - stripped payload.result.rawResponse from both llm-request-completed event
//   types (no reducer reads it)
// Everything else, including offsets and idempotency keys, is verbatim.

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { StreamEvent } from "../../../types.ts";
import { AgentProcessor, reduceAgentEvents } from "../agent-processor-implementation.ts";
import { OpenAiWsProcessor } from "../openai-ws-processor-implementation.ts";
import { OpenAiWsProcessorContract } from "../openai-ws-processor-contract.ts";
import { MemoryStream, deliverNewEvents, fakeResponsesWebSocket } from "../test-helpers.ts";

it("still answers the user when they attach an image format OpenAI cannot ingest", async () => {
  const seeded = JSON.parse(
    readFileSync(new URL("./misha2-1648.events.json", import.meta.url), "utf8"),
  ) as StreamEvent[];
  const stream = new MemoryStream();
  // Direct push (not append) keeps the real prod offsets on the seeded history.
  stream.events.push(...seeded);
  const lastSeededOffset = seeded.at(-1)!.offset;

  // Come into the chat halfway through, exactly like a DO restart: checkpoints
  // say the whole seeded history is already reduced and processed, so side
  // effects fire only for events appended from here on.
  const agent = new AgentProcessor({
    stream,
    readState: async () => ({ offset: lastSeededOffset, state: reduceAgentEvents(seeded) }),
  });
  const openAiWs = new OpenAiWsProcessor({
    stream,
    apiKey: "sk-test",
    createResponsesWebSocketClient: async () => socket,
    readStreamEvents: () => stream.getEvents({ limit: 5000 }),
    readState: async () => ({
      offset: lastSeededOffset,
      state: OpenAiWsProcessorContract.stateSchema.parse({}),
    }),
  });
  const cursors = new Map<object, number>();
  const deliverAll = async () => {
    await deliverNewEvents({ processor: agent, stream, cursors });
    await deliverNewEvents({ processor: openAiWs, stream, cursors });
  };

  // The bad part, verbatim from prod offset 3008 (minus offset/createdAt).
  const [whosThis] = await stream.append({
    type: "events.iterate.com/agent/input-added",
    payload: {
      content: "Who's this",
      files: [
        {
          contentType: "image/heic",
          path: "/agents/1648/f4a019fb-IMG_3159.heic",
          size: 1600374,
          filename: "IMG_3159.heic",
          url: "https://iterate-files--misha2.iterate.app/agents/1648/f4a019fb-IMG_3159.heic?exp=1784047492&sig=3k-IE0vsnT-lGe1VkGKmrVjOxU2AMHLiPrv3w3mvbDo",
        },
      ],
    },
  });

  // Drive delivery: each appended event reaches processors on the next
  // delivery, so deliver after every hop: input -> scheduled -> (debounce
  // timer) requested -> provider execution.
  await deliverAll();
  await stream.waitForEvent({
    afterOffset: whosThis!.offset,
    eventTypes: ["events.iterate.com/agent/llm-request-scheduled"],
    timeoutMs: 1_000,
  });
  await deliverAll();
  await stream.waitForEvent({
    afterOffset: whosThis!.offset,
    eventTypes: ["events.iterate.com/agent/llm-request-requested"],
    timeoutMs: 2_000,
  });
  await deliverAll();

  // Appropriately broad: whatever the mechanism, the user must get an answer.
  const output = await stream.waitForEvent({
    afterOffset: whosThis!.offset,
    eventTypes: ["events.iterate.com/agent/output-added"],
    timeoutMs: 2_000,
  });
  expect(output.payload).toMatchObject({ content: expect.stringContaining("person") });
});

// Behaves like the real OpenAI Responses API did in the prod stream: a request
// carrying an input_image it cannot fetch/decode (the HEIC) fails wholesale
// with the exact error frame from prod offset 3012; anything else answers.
const socket = fakeResponsesWebSocket((request: any) => {
  const parts = (request.input ?? []).flatMap((message: any) =>
    Array.isArray(message.content) ? message.content : [],
  );
  if (parts.some((part: any) => part.type === "input_image" && part.image_url.includes(".heic"))) {
    return [
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          code: "invalid_value",
          message:
            "The image data you provided does not represent a valid image. Please check your input and try again with one of the supported image formats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].",
          param: "input",
        },
        status: 400,
      },
    ];
  }
  return [
    { type: "response.output_text.delta", delta: "Looks like a person in an iPhone photo." },
    { type: "response.completed", response: { id: "resp_repro", usage: { total_tokens: 7 } } },
  ];
});
