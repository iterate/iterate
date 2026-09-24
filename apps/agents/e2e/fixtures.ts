// e2e/fixtures.ts — the agent stories' shared fixtures (agents*.e2e.test.ts): a model that answers
// from a script, the model a story configures, the operator's prompt, the log readers and a 1×1 PNG.
import { RpcTarget } from "capnweb";
import { readAll, sleep, until } from "../../os/e2e/support/client.ts";

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
    .filter((e) => /^events\.iterate\.com\/(agent\/|context\/run-)/.test(e.type))
    .map((e) => e.type.replace("events.iterate.com/", ""));
/** The default model is OpenAI's astra; a local story pins Workers AI so the fake `itx.ai` answers. */
export const WORKERS_AI_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
/** Configure the agent's model: Workers AI by default, or a partner model by name. */
export const configureModel = (
  support: { append: (event: unknown) => Promise<unknown> },
  model = WORKERS_AI_MODEL,
) =>
  support.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model } } },
  });

/** The operator's instructions, their own keyed system item after the birth. */
export const operatorPrompt = (agent: { append: (event: unknown) => Promise<unknown> }) =>
  agent.append({
    type: "events.iterate.com/agent/context-added",
    payload: { role: "system", content: "Be terse." },
    idempotencyKey: "operator-prompt:v1",
  });

/** The context's log once a request has settled. */
export const settledLog = (context: unknown, label: string) =>
  until(label, async () => {
    const all = await readAll(context);
    return all.some((event) => event.type === "events.iterate.com/agent/llm-request-settled")
      ? all
      : undefined;
  });

export const assistantWords = (log: { type: string; payload?: unknown }[]) =>
  log
    .filter((e) => e.type === "events.iterate.com/agent/context-added")
    .map((e) => e.payload as { role: string; content: string })
    .filter((p) => p.role === "assistant")
    .map((p) => p.content);

export const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR42mP4z8AARAwQCgAf7gP9Y167WwAAAABJRU5ErkJggg==";
