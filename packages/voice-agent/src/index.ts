export { VoiceAgentApp, type VoiceAgentEnv } from "./app.ts";
export {
  VOICE_AGENT_WORKER_ENTRYPOINT,
  voiceAgentEntrypointRef,
  voiceAgentFacetRef,
  type VoiceAgentEntrypointRef,
  type VoiceAgentFacetRef,
  type VoiceAgentWorkerSource,
} from "./ref.ts";
export {
  installVoiceAgent,
  LEGACY_GUEST_PATHS,
  legacyGuestPaths,
  removeLegacyGuest,
  VOICE_AGENT_PACKAGE_NAME,
  VOICE_AGENT_PACKAGE_SPEC,
  withVoiceAgentDependency,
  type InstallVoiceAgentOptions,
  type InstallVoiceAgentResult,
  type VoiceAgentConfigRepo,
} from "./install.ts";
// The agent itself is the configured-worker entry, built and run by the
// platform; this entry carries only what a caller needs to reach it.
export type {
  ItxExpressionStepInput,
  SetupVoiceAgentOptions,
  SetupVoiceAgentResult,
  VoiceAgentHealth,
  VoiceAgentRpc,
  VoiceProvider,
  VoiceToolInput,
} from "./setup-options.ts";
