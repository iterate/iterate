import { describe, expect, test } from "vitest";
import { parseObjectFromComposerText } from "~/lib/stream-composer-input.ts";

describe("parseObjectFromComposerText", () => {
  test("parses strict JSON objects in json mode", () => {
    expect(
      parseObjectFromComposerText('{"type":"demo.event","payload":{"count":1}}', "json"),
    ).toEqual({
      type: "demo.event",
      payload: { count: 1 },
    });
  });

  test("accepts trailing commas and bare keys in json mode", () => {
    expect(
      parseObjectFromComposerText("{type: demo.event, payload: {count: 1,},}", "json"),
    ).toEqual({
      type: "demo.event",
      payload: { count: 1 },
    });
  });

  test("still requires an object in json mode", () => {
    expect(() => parseObjectFromComposerText("[1, 2, 3]", "json")).toThrow(
      "Value must be a JSON object.",
    );
  });
});
