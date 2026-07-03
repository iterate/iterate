// Which OS deployment the app talks to. The field is always editable; these
// are the one-tap presets. The deployment must include this branch (the itx
// `voice` builtin) — prod only qualifies once the voice bridge PRs merge.
// Preview slots are LEASED and rotate: re-run the Preview workflow on PR
// #1605, then check the PR's preview comment for the current hostname and
// correct the preset (or just type it in the app).

export type ServerPreset = { label: string; baseUrl: string };

export const SERVER_PRESETS: ServerPreset[] = [
  { label: "PR preview", baseUrl: "https://os.iterate-preview-8.com" },
  { label: "Production", baseUrl: "https://os.iterate.com" },
  { label: "Local dev", baseUrl: "http://localhost:65339" },
];

export const DEFAULT_SERVER = SERVER_PRESETS[0]!.baseUrl;
