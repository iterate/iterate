# Events components

Shared building blocks for stream/event UIs. The stream views themselves live
in `apps/os` (see `apps/os/src/components/project-stream-view.tsx` and its
siblings) and render from the local SQLite mirror; this directory only holds
the pieces shared across apps:

- `types.ts` — the wire `Event` shape and shared event constants.
- `stream-event.ts` — event-type helpers over that shape.
- `agent-ui-reducer.ts` — reduces agent events into chat feed items, live
  activity, and the presence roster. Used by the OS stream views and the
  `iterate` CLI's stream TUI.
- `stream-path-label.tsx` — renders a stream path with domain-aware styling.

The previous clean-room stream-view implementation (stream-feed, rendered
elements, renderer modes, the event-inspector sheet) was superseded by the
apps/os stream-first UI and deleted; see git history if you need it.
