// src/agent/durable-object.ts — THE AGENT: the facet the context at any path hosts under the name
// `agent` (`itx.agents.get(path)`, library.ts — hosted on its first call, addressed after). The loop is
// the processor's (processor.ts); this host is what the processor cannot be: the two effects reached
// through `itx` — the model (`itx.ai.run`, the Workers AI binding under THIS context's rules, so a test
// lends a fake there) and the script runner (`itx.run`, a confined isolate over this context's itx) —
// plus the two doors a client calls: `create()`, which lands the birth (the certificate cross-posted to
// `/` first, then on this path with the system prompt beside it), and `message(text)`, a person's words.
// The library enables the processor row beside `create()`: subscribed, the loop runs on every commit
// and after every eviction. build-sdk.mjs bundles THIS module into AGENT_PROCESSOR_SOURCE.
import { z } from "zod";
import { StreamProcessorDurableObject } from "../sdk/index.ts";
import type { StreamEvent } from "../stream/processor.ts";
import { type AgentView, DEFAULT_AGENT_SYSTEM_PROMPT, type FileAttachment } from "./contract.ts";
import { AgentProcessor } from "./processor.ts";

/** What Workers AI answers a text-generation `run`: `{ response }`, or the chat-completions shape
 *  `{ choices: [{ message: { content } }] }` some models speak. */
const ChatAnswer = z.union([
  z.object({ response: z.string() }),
  z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }),
]);

export class AgentDurableObject extends StreamProcessorDurableObject<AgentView> {
  processor = new AgentProcessor({
    chat: async ({ model, messages }) => {
      const raw = await this.withItx((itx) =>
        // workers-types keys `run`'s inputs by model-name literal; the model is configuration here,
        // and the answer is validated below rather than trusted from the type.
        (itx.ai as unknown as { run(model: string, inputs: unknown): Promise<unknown> }).run(
          model,
          { messages },
        ),
      );
      const answer = ChatAnswer.parse(raw);
      const text = (
        "response" in answer ? answer.response : answer.choices[0]!.message.content
      ).trim();
      if (text === "") throw new Error("the model answered with no text");
      return { text };
    },
    runScript: (code) => this.withItx((itx) => itx.run(code)),
    readFile: (path) => this.withItx((itx) => itx.files.get(path).bytes()),
    now: () => Date.now(),
  });

  #pathRead?: string;
  async #path(): Promise<string> {
    return (this.#pathRead ??= (await this.withItx((itx) => itx.whoami())).path);
  }

  /** Bring the agent into being: the certificate on `/` (the catalog) first, then on this path with
   *  the system prompt beside it (nothing to provision, so nothing fails). Idempotent: a created agent
   *  answers at once. `message()` refuses until this has run. */
  async create(input: { systemPrompt?: string } = {}): Promise<{ path: string }> {
    const path = await this.#path();
    if ((await this.snapshot()).state.path !== null) return { path };
    const certificate = {
      type: "events.iterate.com/agent/created",
      payload: { path },
      idempotencyKey: `agent/created:${path}`,
    };
    await this.withItx((itx) => itx.cd("/").append(certificate));
    await this.withItx((itx) =>
      itx.append(certificate, {
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: `agent/system-prompt:${path}`,
        payload: { role: "system", content: input.systemPrompt || DEFAULT_AGENT_SYSTEM_PROMPT },
      }),
    );
    this.#confirmedCreated = true;
    return { path };
  }

  /** A person's words: ONE `context-added`, the trigger of the next turn — with their attachments,
   *  each stored first under this agent's path (`itx.files`, apps/os's `<path>/<8 of a uuid>-<name>`)
   *  and named on the event; an image among them is what the model will see. The event is answered
   *  so a caller can wait for what follows it. */
  async message(
    input:
      | string
      | {
          message: string;
          files?: {
            contentType: string;
            filename: string;
            data: Uint8Array | ArrayBuffer | string;
          }[];
        },
  ): Promise<StreamEvent> {
    await this.#created();
    const { message, files = [] } = typeof input === "string" ? { message: input } : input;
    const path = await this.#path();
    const attachments: FileAttachment[] = [];
    for (const file of files) {
      const filename = file.filename.replace(/[^A-Za-z0-9._-]+/g, "-");
      const storedAt = `${path}/${crypto.randomUUID().slice(0, 8)}-${filename}`;
      const stored = await this.withItx((itx) =>
        itx.files.get(storedAt).put({ contentType: file.contentType, data: file.data }),
      );
      attachments.push({
        contentType: stored.contentType,
        filename: file.filename,
        path: stored.path,
        size: stored.size,
      });
    }
    const appended = await this.withItx((itx) =>
      itx.append({
        type: "events.iterate.com/agents/context-added",
        payload: {
          role: "user",
          content: message,
          actor: { type: "user" },
          ...(attachments.length > 0 && { files: attachments }),
        },
      }),
    );
    // Over the loopback stub the append's answer types as an RPC result, not the array the door
    // declares (`append(...events): Promise<StreamEvent[]>`, context/built-ins.ts); the wire copied it.
    return (appended as unknown as StreamEvent[])[0]!;
  }

  /** Every door past `create()` starts here: an agent not yet created refuses. Creation is terminal,
   *  so the answer is memoized once seen. */
  #confirmedCreated = false;
  async #created(): Promise<void> {
    if (this.#confirmedCreated) return;
    if ((await this.snapshot()).state.path === null)
      throw new Error(`agent ${await this.#path()}: not created — call create() first`);
    this.#confirmedCreated = true;
  }
}
