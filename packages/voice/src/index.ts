// @iterate-com/voice — a GPT-Live voice conversation on the agents app: the `itx.voice` service a
// device presses (the default export) and the two facet processors each call runs. A project
// installs it from a folder of its config repo that re-exports these three (install.ts); importing
// the package registers `itx.voice` on iterate/api's `InstalledAppRoots` (api.ts).
export { default } from "./worker.ts";
export { VoiceAgentDurableObject } from "./voice-agent.ts";
export { VoiceDelegateDurableObject } from "./voice-delegate.ts";
export type { VoiceApi } from "./api.ts";
