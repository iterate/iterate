// The three sibling stream views, in display order. The `view` query param value is the
// slug (the processor slug for the two processor views; "browser-state" for the RPC-only
// view). This lives in its own module so the router and the switcher can both import it
// without the switcher file exporting a non-component (react-refresh hygiene).
export const STREAM_VIEWS = [
  { slug: "browser-raw-events", label: "Raw events" },
  { slug: "browser-event-feed", label: "Event feed" },
  { slug: "browser-state", label: "State" },
] as const;
