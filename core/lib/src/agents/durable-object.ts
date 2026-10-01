// App-owned agent facet, loaded into a project through the public SDK.
import { StreamProcessorDurableObject } from "../sdk/index.ts";
import type { StreamEvent } from "../stream/processor.ts";
import type { AgentHandleApi } from "./api.ts";
import type { AgentState, FileAttachment } from "./contract.ts";
import { AgentProcessor } from "./processor.ts";

export class AgentDurableObject
  extends StreamProcessorDurableObject<AgentState>
  implements Pick<AgentHandleApi, "message">
{
  /** The processor's reads, and a person's words (`message`) — `itx.agents.get(path).message(…)`
   *  reaches it through the collection (collection.ts). */
  static override publicMethods = [...super.publicMethods, "message"];

  processor = new AgentProcessor({ getItx: () => this.getItx() });

  /** The context this facet is hosted on IS the agent: its path is the one name it goes by, here
   *  and under `itx.files` (attachments are stored beneath it). Read once per incarnation. */
  #pathRead?: string;
  async #path(): Promise<string> {
    if (this.#pathRead) return this.#pathRead;
    using itx = this.getItx();
    const { path } = await itx.whoami();
    return (this.#pathRead = path);
  }

  /** A person's words: ONE `context-added`, the trigger of the next turn — with their attachments,
   *  each stored first under this agent's path (`itx.files`, `<path>/<8 of a uuid>-<name>`)
   *  and named on the event; an image among them is what the model will see. `from` is the
   *  collection's base, which it relays as the sender (collection.ts `AgentReference.message`). The
   *  event is answered so a caller can wait for what follows it. */
  // oxlint-disable-next-line iterate/mechanical-class-impl -- `from` is the collection's relay of the sender, beside the published input: `itx.agents.get(path).message` never takes it
  async message(input: Parameters<AgentHandleApi["message"]>[0], from?: string) {
    const path = await this.#created();
    const { message, files = [] } = typeof input === "string" ? { message: input } : input;
    const attachments: FileAttachment[] = [];
    for (const file of files) {
      const filename = file.filename.replace(/[^A-Za-z0-9._-]+/g, "-");
      const storedAt = `${path}/${crypto.randomUUID().slice(0, 8)}-${filename}`;
      using itx = this.getItx();
      const stored = await itx.files
        .get(storedAt)
        .put({ contentType: file.contentType, data: file.data });
      attachments.push({
        contentType: stored.contentType,
        filename: file.filename,
        path: stored.path,
        size: stored.size,
      });
    }
    using itx = this.getItx();
    const appended = await itx.append({
      type: "events.iterate.com/agent/context-added",
      payload: {
        role: "user",
        content: message,
        actor: { type: "user" },
        ...(attachments.length > 0 && { files: attachments }),
        from,
      },
    });
    // Over the loopback stub the append's answer types as an RPC result, not the array the context
    // declares (`append(...events): Promise<StreamEvent[]>`, context/built-ins.ts); the wire copied it.
    return (appended as unknown as StreamEvent[])[0]!;
  }

  /** Every verb starts here: an agent whose certificate has not landed refuses, and so does one
   *  whose deletion has been asked for. Deletion can land at any moment, so the state is read on
   *  every call (in memory once the facet is caught up). */
  async #created(): Promise<string> {
    const path = await this.#path();
    const { state } = await this.snapshot();
    if (state.deletion) throw new Error(`agent ${path}: deleted`);
    if (state.creation?.status !== "created")
      throw new Error(
        `agent ${path}: not created — itx.agents.create(${JSON.stringify(path)}) first`,
      );
    return path;
  }
}
