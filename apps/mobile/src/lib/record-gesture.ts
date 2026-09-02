// The Telegram hold-to-record gesture as a pure state machine, so every
// branch (tap toggles mode, hold records, slide left cancels, slide up
// locks, locked-mode buttons) is unit-testable without touching a touch
// screen. The component (components/record-button.tsx) maps touch events in
// and performs the returned effect.
//
// Geometry: dx/dy are the finger's offset from where the press started,
// screen coordinates (left and up are negative).

/** Finger travel left of the press origin that abandons the recording. */
export const CANCEL_DX = -70;
/** Finger travel above the press origin that locks hands-free recording. */
export const LOCK_DY = -70;
/** A press shorter than this (that didn't cancel or lock) is a tap: it
 * toggles mic ↔ video instead of producing a clip. */
export const TAP_MS = 300;

export type RecordGestureState =
  | { phase: "idle" }
  | { phase: "holding"; pressedAt: number; dx: number; dy: number }
  | { phase: "locked" };

export type RecordGestureEvent =
  | { type: "press-in"; at: number }
  | { type: "move"; dx: number; dy: number }
  | { type: "press-out"; at: number }
  // Locked-mode buttons:
  | { type: "stop-tap" }
  | { type: "cancel-tap" };

export type RecordGestureEffect =
  /** Begin recording in the current mode. */
  | "start-recording"
  /** Stop recording and attach the clip. */
  | "finish"
  /** Stop recording and throw the clip away. */
  | "cancel"
  /** The press was a tap: throw the (barely started) recording away and
   * switch mic ↔ video, with the explainer tooltip. */
  | "toggle-mode"
  | "none";

export function reduceRecordGesture(
  state: RecordGestureState,
  event: RecordGestureEvent,
): { state: RecordGestureState; effect: RecordGestureEffect } {
  switch (state.phase) {
    case "idle":
      if (event.type === "press-in") {
        return {
          state: { phase: "holding", pressedAt: event.at, dx: 0, dy: 0 },
          effect: "start-recording",
        };
      }
      return { state, effect: "none" };
    case "holding":
      switch (event.type) {
        case "move": {
          if (event.dx <= CANCEL_DX) return { state: { phase: "idle" }, effect: "cancel" };
          if (event.dy <= LOCK_DY) return { state: { phase: "locked" }, effect: "none" };
          return { state: { ...state, dx: event.dx, dy: event.dy }, effect: "none" };
        }
        case "press-out": {
          const wasTap = event.at - state.pressedAt < TAP_MS;
          return { state: { phase: "idle" }, effect: wasTap ? "toggle-mode" : "finish" };
        }
        default:
          return { state, effect: "none" };
      }
    case "locked":
      // The finger already lifted conceptually — a stray press-out from the
      // original touch ending must not stop the locked recording.
      if (event.type === "stop-tap") return { state: { phase: "idle" }, effect: "finish" };
      if (event.type === "cancel-tap") return { state: { phase: "idle" }, effect: "cancel" };
      return { state, effect: "none" };
  }
}

/** How far along the slide-to-cancel drag is, 0..1 — drives the hint's fade
 * so the user can see the cancel coming. */
export function cancelProgress(state: RecordGestureState): number {
  if (state.phase !== "holding" || state.dx >= 0) return 0;
  return Math.min(1, state.dx / CANCEL_DX);
}
