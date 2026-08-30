import { expect, test } from "vitest";
import {
  CANCEL_DX,
  LOCK_DY,
  cancelProgress,
  reduceRecordGesture,
  TAP_MS,
  type RecordGestureEvent,
  type RecordGestureState,
} from "./record-gesture.ts";

function run(events: RecordGestureEvent[]) {
  let state: RecordGestureState = { phase: "idle" };
  const effects: string[] = [];
  for (const event of events) {
    const next = reduceRecordGesture(state, event);
    state = next.state;
    if (next.effect !== "none") effects.push(next.effect);
  }
  return { state, effects };
}

test("quick tap toggles mode instead of recording", () => {
  expect(
    run([
      { type: "press-in", at: 1000 },
      { type: "press-out", at: 1000 + TAP_MS - 1 },
    ]),
  ).toMatchObject({
    state: { phase: "idle" },
    effects: ["start-recording", "toggle-mode"],
  });
});

test("hold then release finishes the recording", () => {
  expect(
    run([
      { type: "press-in", at: 1000 },
      { type: "move", dx: -5, dy: 3 },
      { type: "press-out", at: 3200 },
    ]),
  ).toMatchObject({
    state: { phase: "idle" },
    effects: ["start-recording", "finish"],
  });
});

test("sliding left past the threshold cancels", () => {
  expect(
    run([
      { type: "press-in", at: 1000 },
      { type: "move", dx: -20, dy: 0 },
      { type: "move", dx: CANCEL_DX, dy: 0 },
      // The finger lifting after a cancel must not also finish.
      { type: "press-out", at: 4000 },
    ]),
  ).toMatchObject({
    state: { phase: "idle" },
    effects: ["start-recording", "cancel"],
  });
});

test("small wobbles neither cancel nor lock", () => {
  expect(
    run([
      { type: "press-in", at: 1000 },
      { type: "move", dx: -30, dy: -30 },
    ]),
  ).toMatchObject({ state: { phase: "holding", dx: -30, dy: -30 }, effects: ["start-recording"] });
});

test("sliding up locks; releasing the finger then does nothing", () => {
  expect(
    run([
      { type: "press-in", at: 1000 },
      { type: "move", dx: 0, dy: LOCK_DY },
      { type: "press-out", at: 5000 },
    ]),
  ).toMatchObject({
    state: { phase: "locked" },
    effects: ["start-recording"],
  });
});

test("locked mode: stop finishes, and a long-past tap threshold is irrelevant", () => {
  expect(
    run([{ type: "press-in", at: 1000 }, { type: "move", dx: 0, dy: -200 }, { type: "stop-tap" }]),
  ).toMatchObject({ state: { phase: "idle" }, effects: ["start-recording", "finish"] });
});

test("locked mode: cancel throws the clip away", () => {
  expect(
    run([
      { type: "press-in", at: 1000 },
      { type: "move", dx: 0, dy: -200 },
      { type: "cancel-tap" },
    ]),
  ).toMatchObject({ state: { phase: "idle" }, effects: ["start-recording", "cancel"] });
});

test("cancelProgress ramps toward 1 as the finger approaches the threshold", () => {
  const holding: RecordGestureState = { phase: "holding", pressedAt: 0, dx: CANCEL_DX / 2, dy: 0 };
  expect(cancelProgress(holding)).toBeCloseTo(0.5);
  expect(cancelProgress({ ...holding, dx: 10 })).toBe(0);
  expect(cancelProgress({ phase: "idle" })).toBe(0);
});
