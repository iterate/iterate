// The guest worker: the stateless entrypoint (setup, removal, health) as the
// default export and both stateful facet classes. A config repo's voice-agent.ts
// re-exports these names and the platform builds that file — see INSTALL.md.
import VoiceAgentEntrypoint from "./voice-agent.ts";
import type { VoiceAgentRpc } from "./setup-options.ts";

export { VoiceAgentFacet, VoiceAgentProcessor } from "./voice-agent.ts";

export default class extends VoiceAgentEntrypoint implements VoiceAgentRpc {}
/** What the facet's runtime state reports as `face` (mouth shapes for a face-rendering client). */
export type { FaceValue } from "./face.ts";
