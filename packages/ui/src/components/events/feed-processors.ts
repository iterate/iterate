/**
 * Renderer modes available in the shared stream view component.
 *
 * "raw-pretty" is the default interleaved view; "raw-single-json" dumps every
 * event as a single YAML/JSON block.
 */
export const eventsStreamRendererModes = ["raw-pretty", "pretty", "raw-single-json"] as const;
export type EventsStreamRendererMode = (typeof eventsStreamRendererModes)[number];

export const eventsStreamRendererModeOptions: ReadonlyArray<{
  value: EventsStreamRendererMode;
  label: string;
}> = [
  { value: "raw-pretty", label: "Raw + Pretty" },
  { value: "pretty", label: "Pretty" },
  { value: "raw-single-json", label: "Raw YAML" },
];
