// context/residency-watchdog.test.ts — the watchdog's one decision as a table: what the alarm does
// about it given the armed deadline, the clock, the last inbound call's end and the work in flight.

import { expect, test } from "vitest";
import {
  RESIDENCY_WATCHDOG_WINDOW_MS as W,
  decideQuietDeadline,
  type QuietDeadlineDecision,
} from "./residency-watchdog.ts";

const T = Date.parse("2030-01-01T00:00:00Z");

test.each<{
  row: string;
  armedFor: number | null;
  now: number;
  lastCallEndedAt: number | null;
  workInFlight: number;
  expected: QuietDeadlineDecision;
}>([
  {
    row: "a fresh incarnation armed nothing: its armer was evicted, the wake does nothing",
    armedFor: null,
    now: T + W,
    lastCallEndedAt: null,
    workInFlight: 0,
    expected: { action: "none" },
  },
  {
    row: "a fresh incarnation with a call in flight still does nothing",
    armedFor: null,
    now: T + W,
    lastCallEndedAt: T,
    workInFlight: 3,
    expected: { action: "none" },
  },
  {
    row: "not yet due (an earlier deadline woke the alarm): the deadline stands",
    armedFor: T + W,
    now: T + W - 1,
    lastCallEndedAt: T,
    workInFlight: 0,
    expected: { action: "none" },
  },
  {
    row: "work in flight at the deadline: a whole window from now",
    armedFor: T + W,
    now: T + W,
    lastCallEndedAt: T,
    workInFlight: 1,
    expected: { action: "rearm", at: T + 2 * W },
  },
  {
    row: "a call ended inside the window: re-armed a window after that call",
    armedFor: T + W,
    now: T + W,
    lastCallEndedAt: T + 5 * 60_000,
    workInFlight: 0,
    expected: { action: "rearm", at: T + 5 * 60_000 + W },
  },
  {
    row: "a call ended one millisecond inside the window: still re-armed",
    armedFor: T + W,
    now: T + W,
    lastCallEndedAt: T + 1,
    workInFlight: 0,
    expected: { action: "rearm", at: T + 1 + W },
  },
  {
    row: "quiet exactly one window, nothing in flight: held — recorded",
    armedFor: T + W,
    now: T + W,
    lastCallEndedAt: T,
    workInFlight: 0,
    expected: { action: "due", idleSince: T },
  },
  {
    row: "a late alarm (retries, a busy machine): recorded from the last call's end",
    armedFor: T + W,
    now: T + 3 * W,
    lastCallEndedAt: T + 60_000,
    workInFlight: 0,
    expected: { action: "due", idleSince: T + 60_000 },
  },
  {
    row: "no call has ended and none is in flight: the arming instant is the quiet window's start",
    armedFor: T + W,
    now: T + W,
    lastCallEndedAt: null,
    workInFlight: 0,
    expected: { action: "due", idleSince: T },
  },
])("$row", ({ expected, ...input }) => {
  expect(decideQuietDeadline({ ...input, windowMs: W })).toEqual(expected);
});
