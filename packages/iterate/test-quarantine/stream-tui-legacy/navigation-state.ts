// QUARANTINED (itx-v4 cutover, Phase 10): origin packages/iterate/src/stream-tui/navigation-state.ts.
// Part of the legacy stream-browser TUI built on the old engine's /api/itx/run
// client; superseded by the agent chat TUI in src/stream-tui/. See ../README.md.

export type StreamTuiView = "feed" | "state" | "streams";
export type StreamTuiFocus = "composer" | "feed" | "header";

export type StreamTuiNavigationState = {
  view: StreamTuiView;
  focus: StreamTuiFocus;
};

export const initialStreamTuiNavigationState: StreamTuiNavigationState = {
  view: "feed",
  focus: "composer",
};

export function setStreamTuiView(
  state: StreamTuiNavigationState,
  view: StreamTuiView,
): StreamTuiNavigationState {
  return {
    ...state,
    view,
    focus: "composer",
  };
}

export function focusStreamTuiFeed(state: StreamTuiNavigationState): StreamTuiNavigationState {
  return {
    ...state,
    focus: "feed",
  };
}

export function focusStreamTuiComposer(state: StreamTuiNavigationState): StreamTuiNavigationState {
  return {
    ...state,
    focus: "composer",
  };
}

export function focusStreamTuiHeader(state: StreamTuiNavigationState): StreamTuiNavigationState {
  return {
    ...state,
    focus: "header",
  };
}
