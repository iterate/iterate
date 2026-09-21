// src/agent/durable-object.ts — THE AGENT: the facet the context at any path hosts under the name
// `agent` (`itx.agents.get(path)`, library.ts — hosted on its first call, addressed after). This host
// is the processor's SHELL plus `message()`: the loop, the model call (a `@cf/…` model through
// `itx.ai`, anything else through the account's AI Gateway) and the birth are all the processor's
// (processor.ts), reached through the `withItx` and the env handed in here. Creation is
// `itx.agents.create(path)` (src/agent/collection.ts): the processor row on the path, then
// `agent/create-requested`, then the saga in the processor lands the certificate — cross-posted to `/`
// first, then here with the default system prompt beside it. `message(text)`, a person's words, is
// the one verb of its own, and it refuses until the certificate has landed (`state.creation`).
// Subscribed, the loop runs on every commit and after every eviction. Hosted from `ctx.exports`
// (first-party-facets.ts): ordinary bundled worker code.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/next/sdk";
import type { StreamEvent } from "iterate/next/stream/processor";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { AppConfigEnv } from "../app-config.ts";
import type { AgentState, FileAttachment } from "./contract.ts";
import { AgentProcessor } from "./processor.ts";

export class AgentDurableObject extends StreamProcessorDurableObject<
  AgentState,
  { ITX?: ItxEntrypointService; AI: Ai } & AppConfigEnv,
  ItxEntrypointScope
> {
  processor = new AgentProcessor({ withItx: (call) => this.withItx(call), env: this.env });

  /** The context this facet is hosted on IS the agent: its path is the one name it goes by, here
   *  and under `itx.files` (attachments are stored beneath it). Read once per incarnation. */
  #pathRead?: string;
  async #path(): Promise<string> {
    if (this.#pathRead) return this.#pathRead;
    const { path } = await this.withItx((itx) => itx.whoami());
    return (this.#pathRead = path);
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
    const path = await this.#created();
    const { message, files = [] } = typeof input === "string" ? { message: input } : input;
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
        type: "events.iterate.com/agent/context-added",
        payload: {
          role: "user",
          content: message,
          actor: { type: "user" },
          ...(attachments.length > 0 && { files: attachments }),
        },
      }),
    );
    // Over the loopback stub the append's answer types as an RPC result, not the array the context
    // declares (`append(...events): Promise<StreamEvent[]>`, context/built-ins.ts); the wire copied it.
    return (appended as unknown as StreamEvent[])[0]!;
  }

  /** Every verb starts here: an agent whose certificate has not landed refuses. Creation is
   *  terminal, so one confirming read per incarnation. */
  #confirmedCreated = false;
  async #created(): Promise<string> {
    const path = await this.#path();
    if (!this.#confirmedCreated) {
      if ((await this.snapshot()).state.creation?.status !== "created")
        throw new Error(
          `agent ${path}: not created — itx.agents.create(${JSON.stringify(path)}) first`,
        );
      this.#confirmedCreated = true;
    }
    return path;
  }
}
