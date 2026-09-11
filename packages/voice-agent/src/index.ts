export { VoiceAgentApp, type VoiceAgentAppOptions, type VoiceAgentEnv } from "./app.ts";
export {
  VOICE_AGENT_GUEST_FILE,
  voiceAgentEntrypointRef,
  voiceAgentFacetRef,
  type VoiceAgentEntrypointRef,
  type VoiceAgentFacetRef,
  type VoiceAgentWorkerSource,
} from "./ref.ts";
export {
  installVoiceAgent,
  installVoiceAgentFromSource,
  LEGACY_GUEST_PATHS,
  legacyGuestPaths,
  removeLegacyGuest,
  VOICE_AGENT_GUEST_SOURCE,
  VOICE_AGENT_GUEST_SOURCE_FROM_REPO,
  VOICE_AGENT_PACKAGE_NAME,
  VOICE_AGENT_PACKAGE_SPEC,
  VOICE_AGENT_SOURCE_DIR,
  VOICE_AGENT_SOURCE_FILES,
  VOICE_AGENT_ZOD_SPEC,
  withVoiceAgentDependency,
  withVoiceAgentSourceDependencies,
  withVoiceAgentGuestFile,
  type InstallVoiceAgentOptions,
  type InstallVoiceAgentResult,
  type VoiceAgentConfigRepo,
} from "./install.ts";
// The agent itself is the `./worker` entry, which a config repo's
// voice-agent.ts re-exports; this entry carries only what a caller needs to
// enable and reach it.
export type {
  ItxExpressionStepInput,
  SetupVoiceAgentOptions,
  SetupVoiceAgentResult,
  VoiceAgentHealth,
  VoiceAgentRpc,
  VoiceBackendInput,
  VoiceToolInput,
} from "./setup-options.ts";
