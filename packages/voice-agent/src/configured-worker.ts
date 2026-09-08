// The guest worker as the dynamic worker host loads it: the stateless
// entrypoint (setup, health, removal) as the default export, and the stateful
// facet class that `voiceAgentFacetRef` names by className.
export { default, VoiceAgentFacet } from "./voice-agent.ts";
