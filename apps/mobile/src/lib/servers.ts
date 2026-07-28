// Adapted from the voice-ios-app branch (PR #1605) apps/mobile/src/lib/servers.ts.
// Divergence: chat-first preset list — Production default plus every preview
// slot (hostnames follow the stable envs.ts previewSlot(n) convention), no
// PR-specific preview host baked in. Custom URLs (e.g. captun tunnels for
// local dev — https://<name>.tunnels.iterate.com) go in the same free-text
// field and are persisted as recents (storage.ts).

import { deployedPreviewEnvs, envs } from "../../../../envs.ts";

export type ServerPreset = { label: string; baseUrl: string };

export const SERVER_PRESETS: ServerPreset[] = [
  { label: "Production", baseUrl: envs.prd.baseUrl },
  ...deployedPreviewEnvs.map((env) => ({
    label: env.dopplerConfig.replace("_", " "),
    baseUrl: env.baseUrl,
  })),
];

export const DEFAULT_SERVER = envs.prd.baseUrl;
