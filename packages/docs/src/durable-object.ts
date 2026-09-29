// docs/durable-object.ts — the loadable hosts (frames.ts): the doc processor, handed this facet's
// storage and its itx (whose `whoami()` names the doc), with `sync` for a browser joining;
// and the root's docs processor (root.ts).
import { StreamProcessorDurableObject } from "iterate/sdk";
import type { ProcessorState } from "iterate/stream/processor";
import type { DocContract, DocsContract } from "./contract.ts";
import { DocProcessor } from "./processor.ts";
import { DocsProcessor } from "./root.ts";

export class DocDurableObject extends StreamProcessorDurableObject<
  ProcessorState<typeof DocContract>
> {
  static override publicMethods = [...super.publicMethods, "sync"];

  processor = new DocProcessor({
    sql: this.ctx.storage.sql,
    getItx: () => this.getItx(),
    publishLiveState: () => this.publishLiveState(),
    // a minute after the first unsaved edit, however much typing follows (or sooner: the last tab
    // leaving); each commit to a repo like /repos/config republishes the project's site
    autosave: { idleMs: 60_000, maxMs: 60_000 },
  });

  sync(stateVector: string, client: number) {
    return this.processor.sync(stateVector, client);
  }
}

export class DocsDurableObject extends StreamProcessorDurableObject<
  ProcessorState<typeof DocsContract>
> {
  processor = new DocsProcessor(() => this.getItx());
}
