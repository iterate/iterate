// The voice agent guest worker. The platform builds this file (see
// @iterate-com/voice-agent/INSTALL.md); the agent lives in the package and
// this repo holds its name. Subclass here if the project needs to.
export { default, VoiceAgentFacet } from "@iterate-com/voice-agent/worker";
