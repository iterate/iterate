# test-quarantine

Suites and modules parked here are EXCLUDED from typecheck, test, and build
runs (`packages/iterate/tsconfig.json` includes only `src/**`; the package has
no vitest lane of its own). Kept as reference per the itx-v4 migration's
quarantine-over-delete policy.

## stream-tui-legacy (pre-itx-v4 stream browser TUI)

The original `iterate chat` TUI: a general event-stream browser (stream tree,
raw/mixed/pretty feed modes, slash-command router, event detail view) built on
the legacy engine's `/api/itx/run` polling client and the legacy shared
reducer (`@iterate-com/ui .../stream-view-processor`,
`@iterate-com/shared/streams/types`). Replaced in Phase 10 by the agent chat
TUI in `src/stream-tui/` (shared `connectItx` client + shared agent-ui
reducer). Path back for any piece: rebuild it on
`apps/os/src/next/client.ts` + the next engine event model.

- `event-stream-terminal.tsx` — old entrypoint: /api/itx/run polling, OAuth refresh machinery, keyboard routing.
- `react-stream-renderers.tsx` — feed/state/streams/detail renderables for the legacy reduced view state.
- `react-stream-view-model.ts` — raw-event summaries + slash suggestion view model.
- `command-router.ts` / `.test.ts` — oRPC-modeled local command hierarchy (/view._, /append._, /streams…).
- `command-discovery.ts` / `.test.ts` — slash suggestion matching.
- `command-invocation.ts` / `.test.ts` — slash arg parsing.
- `navigation-state.ts` / `.test.ts` — view/focus state machine.
- `feed-formatting.ts` / `.test.ts` — terminal formatting for legacy feed elements.
- `stream-paths.ts` / `.test.ts` — current-stream-relative path resolution.
- `stream-tree.ts` / `.test.ts` — stream tree rows/expansion/search.
