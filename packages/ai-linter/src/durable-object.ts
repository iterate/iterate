// ai-linter/durable-object.ts — the loadable host: the processor, handed this facet's itx.
import { StreamProcessorDurableObject } from "iterate/sdk";
import { AiLinterProcessor, type AiLinterState } from "./processor.ts";

export class AiLinterDurableObject extends StreamProcessorDurableObject<AiLinterState> {
  processor = new AiLinterProcessor(() => this.getItx(), this.ctx.storage);
}
