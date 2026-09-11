// The guest worker: the stateless entrypoint (setup, removal, health) as the
// default export, and the stateful facet class that `voiceAgentFacetRef` names
// by className. A config repo's voice-agent.ts re-exports these two names and
// the platform builds that file — see INSTALL.md.
export { default, VoiceAgentFacet } from "./voice-agent.ts";
/** What the facet's runtime state reports as `face` (mouth shapes for a face-rendering client). */
export type { FaceValue } from "./face.ts";
