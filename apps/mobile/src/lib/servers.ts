// Adapted from the voice-ios-app branch (PR #1605) apps/mobile/src/lib/servers.ts.
// Divergence: chat-first preset list — Production default plus every preview
// slot (hostnames follow the stable envs.ts previewSlot(n) convention), no
// PR-specific preview host baked in. Custom URLs (e.g. captun tunnels for
// local dev — https://<name>.tunnels.iterate.com) go in the same free-text
// field and are persisted as recents (storage.ts).

export type ServerPreset = { label: string; baseUrl: string };

export const SERVER_PRESETS: ServerPreset[] = [
  { label: "Production", baseUrl: "https://os.iterate.com" },
  ...Array.from({ length: 9 }, (_, i) => ({
    label: `preview ${i + 1}`,
    baseUrl: `https://os.iterate-preview-${i + 1}.com`,
  })),
];

export const DEFAULT_SERVER = SERVER_PRESETS[0]!.baseUrl;
