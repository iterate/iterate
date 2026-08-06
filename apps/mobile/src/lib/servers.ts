// Adapted from the voice-ios-app branch (PR #1605) apps/mobile/src/lib/servers.ts.
// Divergence: chat-first preset list — Production default plus every preview
// slot (hostnames follow the stable envs.ts previewSlot(n) convention), no
// PR-specific preview host baked in. Custom URLs (e.g. captun tunnels for
// local dev — https://<name>.tunnels.iterate.com) go in the same free-text
// field and are persisted as recents (storage.ts).

import { deployedPreviewEnvs, envs } from "../../../../envs.ts";

export type ServerPreset = { label: string; baseUrl: string; envKey: string };

export const SERVER_PRESETS: ServerPreset[] = [
  { label: "Production", baseUrl: envs.prd.baseUrl, envKey: envs.prd.dopplerConfig },
  ...deployedPreviewEnvs.map((env) => ({
    label: env.dopplerConfig.replace("_", " "),
    baseUrl: env.baseUrl,
    envKey: env.dopplerConfig,
  })),
];

export const DEFAULT_SERVER = envs.prd.baseUrl;

/**
 * Resolve a deep link's recommended-backend param (an envs.ts config key,
 * e.g. "preview_12") to a known preset. Lookup-only on purpose: a crafted
 * link must never be able to point the app — and its OAuth flow — at an
 * arbitrary server, so anything that isn't a preset resolves to null and the
 * link degrades to a plain channel switch.
 */
export function serverPresetForEnvKey(envKey: string): ServerPreset | null {
  return SERVER_PRESETS.find((preset) => preset.envKey === envKey) || null;
}
