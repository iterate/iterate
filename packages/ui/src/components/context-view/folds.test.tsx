// Folding the log for reading: days, housekeeping runs, repeated facts — and that the raw modes fold nothing.
// The fixture's two days sit 48 h apart at noon UTC, so they are two local days in every timezone.
import { describe, expect, test } from "vitest";
import { foldEvents, lastEventOf, sentenceText } from "./folds.tsx";
import { housekeepingSummary } from "./core-renderers.tsx";
import type { ContextViewEvent } from "./types.tsx";

const at = (offset: number, type: string, payload?: unknown, iso = "2026-09-21T19:00:00.000Z") =>
  ({
    offset,
    type: `events.iterate.com/${type}`,
    createdAt: iso,
    payload,
  }) satisfies ContextViewEvent;

const log: ContextViewEvent[] = [
  at(1, "stream/created", { path: "/" }),
  at(2, "stream/woken", { incarnation: 1 }),
  at(3, "stream/subscription-configured", { name: "account" }),
  at(4, "account/authenticated", { credential: "cookie" }),
  at(5, "account/authenticated", { credential: "cookie" }),
  at(6, "account/authenticated", { credential: "cookie" }),
  at(7, "account/authenticated", { credential: "admin-secret" }),
  at(8, "stream/woken", { incarnation: 2 }, "2026-09-23T12:00:00.000Z"),
  at(9, "stream/subscription-configured", { name: "sub-1" }, "2026-09-23T12:00:00.000Z"),
  at(10, "live-state/changed", undefined, "2026-09-23T12:00:01.000Z"),
  at(11, "account/grant-minted", { grantId: "grant_a" }, "2026-09-23T12:00:02.000Z"),
];

describe("foldEvents", () => {
  test("pretty: a day mark, housekeeping runs folded, a repeated fact shown once with its count", () => {
    const items = foldEvents(log, "pretty");
    expect(items.map((item) => item.kind)).toEqual([
      "day",
      "event", // born
      "housekeeping", // woken + subscription
      "repeat", // 3 cookie sign-ins
      "event", // the admin-secret sign-in differs in payload
      "day",
      "housekeeping", // woken + subscription + live state
      "event", // grant minted
    ]);
    const repeat = items[3];
    expect(repeat.kind === "repeat" && repeat.events.map((e) => e.offset)).toEqual([4, 5, 6]);
    const housekeeping = items[6];
    expect(housekeeping.kind === "housekeeping" && housekeeping.events.length).toBe(3);
  });
  test("a lone housekeeping event stays a plain row; a run never crosses a day", () => {
    const items = foldEvents([log[0]!, log[1]!, log[3]!], "pretty");
    expect(items.map((item) => item.kind)).toEqual(["day", "event", "event", "event"]);
    const acrossDays = foldEvents([log[1]!, log[7]!], "pretty");
    expect(acrossDays.map((item) => item.kind)).toEqual(["day", "event", "day", "event"]);
  });
  test("pretty + raw and raw keep every event; only the days are marked", () => {
    for (const mode of ["pretty-raw", "raw"] as const) {
      const items = foldEvents(log, mode);
      expect(items.filter((item) => item.kind === "event")).toHaveLength(log.length);
      expect(items.filter((item) => item.kind === "day")).toHaveLength(2);
    }
  });
  test("lastEventOf anchors the next gap at the end of a fold", () => {
    const items = foldEvents(log, "pretty");
    expect(lastEventOf(items[3])?.offset).toBe(6);
    expect(lastEventOf(items[0])).toBeUndefined();
  });
});

test("housekeepingSummary counts by kind", () => {
  expect(
    housekeepingSummary([log[1]!, log[2]!, log[7]!, log[8]!, log[9]!].map((e) => e.type)),
  ).toBe("woke ×2 · subscriptions ×2 · live state ×1");
});

describe("the same fact is the same sentence", () => {
  test("payloads that differ only in timestamps and ids fold when a fact key says they read the same", () => {
    const signIns = [
      at(1, "account/authenticated", { credential: "cookie", at: 1, operationId: "a" }),
      at(2, "account/authenticated", { credential: "cookie", at: 2, operationId: "b" }),
      at(3, "account/authenticated", { credential: "admin-secret", at: 3, operationId: "c" }),
    ];
    expect(foldEvents(signIns, "pretty").map((item) => item.kind)).toEqual([
      "day",
      "event",
      "event",
      "event",
    ]);
    expect(
      foldEvents(
        signIns,
        "pretty",
        // the sentence would read the credential only — so key by it
        (event) => `${event.type}:${String((event.payload as { credential: string }).credential)}`,
      ).map((item) => item.kind),
    ).toEqual(["day", "repeat", "event"]);
  });
  test("sentenceText walks strings, numbers, arrays and elements' children", () => {
    expect(
      sentenceText(
        <>
          Approved <strong>Claude Code</strong> for {1} project{["(s)", null, false]}
        </>,
      ),
    ).toBe("Approved Claude Code for 1 project(s)");
  });
});
