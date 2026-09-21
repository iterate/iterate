// e2e/support/agents.ts — the agent stories' shared fixtures (agents*.e2e.test.ts): a model that answers
// from a script, the Workers AI model a local story pins, the log readers and a 1×1 PNG.
import { RpcTarget } from "capnweb";
import { sleep } from "./client.ts";

/** A model that answers from a script of replies, in order, recording what it was asked. A reply
 *  may take its time (`{ text, afterMs }`): the request stays in flight that long — what an
 *  interruption needs to have something to cut short. The fake answers WHOLE (a lent stub carries
 *  no stream), so the loop journals its one chunk window; streaming proper is the deployed story. */
export class ScriptedAi extends RpcTarget {
  readonly calls: { model: string; messages: { role: string; content: string }[] }[] = [];
  constructor(private readonly replies: (string | Error | { text: string; afterMs: number })[]) {
    super();
  }
  async run(model: string, inputs: { messages: { role: string; content: string }[] }) {
    this.calls.push({ model, messages: inputs.messages });
    const reply = this.replies[Math.min(this.calls.length, this.replies.length) - 1];
    if (reply instanceof Error) throw reply;
    if (typeof reply === "string") return { response: reply };
    await sleep(reply.afterMs);
    return { response: reply.text };
  }
}

export const short = (log: { type: string }[]) =>
  log
    .filter((e) => /agent|context-added|context\/run/.test(e.type) && !/subscription/.test(e.type))
    .map((e) => e.type.replace("events.iterate.com/", ""));
/** The default model is OpenAI's astra; a local story pins Workers AI so the fake `itx.ai` answers. */
export const WORKERS_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const onWorkersAi = (
  support: { append: (event: unknown) => Promise<unknown> },
  model = WORKERS_AI_MODEL,
) =>
  support.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model } } },
  });

export const assistantWords = (log: { type: string; payload?: unknown }[]) =>
  log
    .filter((e) => e.type === "events.iterate.com/agents/context-added")
    .map((e) => e.payload as { role: string; content: string })
    .filter((p) => p.role === "assistant")
    .map((p) => p.content);

export const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mP4z8AARAwQCgAf7gP9Y167WwAAAABJRU5ErkJggg==";
