import { Event, StreamPath } from "@iterate-com/shared/streams/types";
import { describe, expect, test } from "vitest";
import {
  formatElapsedTime,
  getElapsedByOffset,
  orderEventKeysForYamlDisplay,
  rightAlign,
  wrapLine,
} from "./feed-formatting.ts";

describe("feed formatting", () => {
  test("orders raw event YAML fields and hides streamPath", () => {
    const event = Event.parse({
      streamPath: StreamPath.parse("/demo"),
      type: "demo",
      payload: { ok: true },
      offset: 1,
      createdAt: "2026-04-29T00:00:00.000Z",
    });

    expect(orderEventKeysForYamlDisplay(event)).toEqual({
      type: "demo",
      payload: { ok: true },
      offset: 1,
      createdAt: "2026-04-29T00:00:00.000Z",
    });
  });

  test("calculates elapsed labels across raw feed items", () => {
    expect(
      getElapsedByOffset([
        {
          type: "grouped-raw-event",
          id: "1",
          props: {
            eventType: "first",
            count: 1,
            firstTimestamp: 1_000,
            lastTimestamp: 1_000,
            events: [
              {
                streamPath: StreamPath.parse("/demo"),
                offset: 1,
                eventType: "first",
                createdAt: "2026-04-29T00:00:00.000Z",
                timestamp: 1_000,
                raw: Event.parse({
                  streamPath: StreamPath.parse("/demo"),
                  type: "first",
                  payload: {},
                  offset: 1,
                  createdAt: "2026-04-29T00:00:00.000Z",
                }),
              },
            ],
          },
        },
        {
          type: "grouped-raw-event",
          id: "2",
          props: {
            eventType: "second",
            count: 1,
            firstTimestamp: 2_250,
            lastTimestamp: 2_250,
            events: [
              {
                streamPath: StreamPath.parse("/demo"),
                offset: 2,
                eventType: "second",
                createdAt: "2026-04-29T00:00:01.250Z",
                timestamp: 2_250,
                raw: Event.parse({
                  streamPath: StreamPath.parse("/demo"),
                  type: "second",
                  payload: {},
                  offset: 2,
                  createdAt: "2026-04-29T00:00:01.250Z",
                }),
              },
            ],
          },
        },
      ]),
    ).toEqual(new Map([[2, "+1.2s"]]));
  });

  test("wraps, aligns, and formats elapsed durations", () => {
    expect(wrapLine("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
    expect(rightAlign("abcdef", 4)).toBe("cdef");
    expect(formatElapsedTime(61_500)).toBe("+1m1s");
  });
});
