// Adapted from the voice-ios-app branch (PR #1605) apps/mobile/src/lib/servers.ts.
// Divergence: the preset list (Production plus every preview slot, hostnames
// following the stable envs.ts previewSlot(n) convention) exists for
// VALIDATION — resolving a bundle's expected-backend stamp to a known
// deployment. The sign-in UI shows at most two of them (Production + the
// expected backend); anything else (captun tunnels for local dev —
// https://<name>.tunnels.iterate.com) goes in the free-text field.

import { deployedPreviewEnvs, envs } from "../../../../envs.ts";

export type ServerPreset = { label: string; baseUrl: string; envKey: string };

export const PRODUCTION_PRESET: ServerPreset = {
  label: "Production",
  baseUrl: envs.prd.baseUrl,
  envKey: envs.prd.dopplerConfig,
};

export const SERVER_PRESETS: ServerPreset[] = [
  PRODUCTION_PRESET,
  ...deployedPreviewEnvs.map((env) => ({
    label: env.dopplerConfig.replace("_", " "),
    baseUrl: env.baseUrl,
    envKey: env.dopplerConfig,
  })),
];

export const DEFAULT_SERVER = envs.prd.baseUrl;

/**
 * Resolve an expected-backend stamp (an envs.ts config key, e.g.
 * "preview_12") to a known preset. Lookup-only on purpose: a poisoned stamp
 * must never be able to point the app — and its OAuth flow — at an arbitrary
 * server, so anything that isn't a preset resolves to null and the stamp is
 * ignored.
 */
export function serverPresetForEnvKey(envKey: string): ServerPreset | null {
  return SERVER_PRESETS.find((preset) => preset.envKey === envKey) || null;
}
