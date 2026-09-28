// docs/durable-object.ts — the loadable hosts (frames.ts): the doc processor, handed this facet's
// storage, its itx and its context's path (which names the doc), with `sync` for a browser joining;
// and the root's docs processor (root.ts).
import { StreamProcessorDurableObject } from "iterate/sdk";
import type { ProcessorState } from "iterate/stream/processor";
import type { DocsContract } from "./contract.ts";
import { docPathOf } from "./frames.ts";
import { DocProcessor } from "./processor.ts";
import { DocsProcessor } from "./root.ts";

export class DocDurableObject extends StreamProcessorDurableObject<Record<string, never>> {
  static override publicMethods = [...super.publicMethods, "sync"];

  processor = new DocProcessor({
    sql: this.ctx.storage.sql,
    withItx: (call) => this.withItx(call),
    path: docPathOf(this.ctx.props.iterateContextName),
    publishLiveState: () => this.publishLiveState(),
    autosave: { idleMs: 1500, maxMs: 8000 },
  });

  sync(stateVector: string) {
    return this.processor.sync(stateVector);
  }
}

export class DocsDurableObject extends StreamProcessorDurableObject<
  ProcessorState<typeof DocsContract>
> {
  processor = new DocsProcessor((call) => this.withItx(call));
}
