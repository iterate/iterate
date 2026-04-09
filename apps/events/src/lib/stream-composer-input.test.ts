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

  test("parses quoted shell commands in yaml mode", () => {
    expect(
      parseObjectFromComposerText(
        `type: bashmode-block-added
payload:
  script: "curl --json '{\\"type\\": \\"hi\\"}' https://events.iterate.com/api/streams/jonas/bla/new/new/new"`,
        "yaml",
      ),
    ).toEqual({
      type: "bashmode-block-added",
      payload: {
        script: `curl --json '{"type": "hi"}' https://events.iterate.com/api/streams/jonas/bla/new/new/new`,
      },
    });
  });

  test("adds a helpful hint for yaml strings containing colons", () => {
    expect(() =>
      parseObjectFromComposerText(
        `type: bashmode-block-added
payload:
  script: curl --json '{"type": "hi"}' https://events.iterate.com/api/streams/jonas/bla/new/new/new`,
        "yaml",
      ),
    ).toThrow("wrap it in quotes or use a block scalar (|)");
  });
});
