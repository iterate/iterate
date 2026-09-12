// src/client/presence/durable-object.ts — the presence processor's HOST: the class a dynamic worker
// facet loads (`itx.facets.get('presence', { source, className: 'PresenceDurableObject' })`).
// build-sdk.mjs bundles THIS — pulling `PresenceProcessor` from ./processor.ts (the tested spec) —
// into PRESENCE_PROCESSOR_SOURCE, the SDK imports left external as "./processor.js".
import { StreamProcessorDurableObject } from "../../sdk/index.ts";
import { PresenceProcessor } from "./processor.ts";

export class PresenceDurableObject extends StreamProcessorDurableObject {
  processor = new PresenceProcessor();
}
