// src/client/presence/durable-object.ts — the presence processor's HOST: the class a dynamic worker
// facet loads (`itx.facets.get('presence', { source, className: 'PresenceDurableObject' })`).
// The e2e fixtures load these TypeScript files as the facet's source unchanged (e2e/support/sources.ts);
// the loader links `iterate/*` and `zod` to this deployment's SDK build (context/module-resolution.ts).
import { StreamProcessorDurableObject } from "iterate/sdk";
import { PresenceProcessor } from "./processor.ts";

export class PresenceDurableObject extends StreamProcessorDurableObject {
  processor = new PresenceProcessor();
}
