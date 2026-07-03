// Which OS deployment the app talks to. The field is always editable; these
// are the one-tap presets. The default is this branch's PR preview slot —
// prod won't have the voice bridge until PR #1591 and #1605 merge. Preview
// leases expire; pushing to the PR (or re-running its preview workflow)
// re-deploys the slot.

export type ServerPreset = { label: string; baseUrl: string };

export const SERVER_PRESETS: ServerPreset[] = [
  { label: "PR preview", baseUrl: "https://os.iterate-preview-5.com" },
  { label: "Production", baseUrl: "https://os.iterate.com" },
  { label: "Local dev", baseUrl: "http://localhost:65339" },
];

export const DEFAULT_SERVER = SERVER_PRESETS[0]!.baseUrl;
