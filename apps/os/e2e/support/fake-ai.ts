// e2e/support/fake-ai.ts — the one fake `itx.ai`: Cloudflare's Workers AI binding played by a script,
// what a row lends in its place (`provide("itx.ai", new FakeAi([...]))`) so a run never pays for a
// model (docs/testing.md#real-model-rows).
import { RpcTarget } from "capnweb";

/** One `run(model, inputs, options)` as the fake received it. `messages` is typed because chat rows
 *  read it; the Responses API's `input`, or a bare `prompt`, arrive instead, through the index. */
type FakeAiCall = {
  model: string;
  inputs: { messages: { role: string; content: string }[]; [field: string]: any };
  options?: unknown;
};

/** An answer: text, which Workers AI answers as `{ response }`; an Error, thrown; or a function of
 *  the call returning what the binding would (an object, a `Response`, a `ReadableStream`). */
export type FakeAiReply = string | Error | ((call: FakeAiCall) => unknown);

/** The binding, answering each `run` with the next reply of `replies` (the last one repeats) and
 *  recording every call. */
export class FakeAi extends RpcTarget {
  readonly calls: FakeAiCall[] = [];
  readonly #replies: FakeAiReply[];
  constructor(replies: FakeAiReply[]) {
    super();
    this.#replies = replies;
  }
  async run(model: string, inputs: FakeAiCall["inputs"], options?: unknown) {
    const call = { model, inputs, options };
    this.calls.push(call);
    const reply = this.#replies[Math.min(this.calls.length, this.#replies.length) - 1];
    if (reply instanceof Error) throw reply;
    return typeof reply === "string" ? { response: reply } : reply(call);
  }
  gateway(id: string) {
    return new FakeAiGateway(id);
  }
  models() {
    return [{ name: "@cf/fake/model" }];
  }
}

/** The binding's gateway half, an RpcTarget so a mid-chain `.run(request)` rides back here: it
 *  answers with the request it was handed. */
class FakeAiGateway extends RpcTarget {
  readonly #id: string;
  constructor(id: string) {
    super();
    this.#id = id;
  }
  run(request: unknown) {
    return { gateway: this.#id, request };
  }
}

/** A streamed answer: each frame one Server-Sent Event's `data:` line, in order. A promise among the
 *  frames holds the stream until it settles; one that never settles never ends it. */
export function sseStream(frames: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const frame of frames) {
        if (frame instanceof Promise) await frame;
        else controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      }
      controller.close();
    },
  });
}

/** `sseStream(frames)` as a partner model's (the Responses API's) HTTP answer. */
export function sseResponse(frames: unknown[]) {
  return new Response(sseStream(frames), { headers: { "content-type": "text/event-stream" } });
}
