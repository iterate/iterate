import { describe, expect, test } from "vitest";
import { validateStreamFeedReadInput } from "./read-input.ts";

describe("validateStreamFeedReadInput", () => {
  test("accepts and copies a complete bounded filter", () => {
    const input = {
      offset: 2,
      limit: 50,
      filter: {
        agent: { showDebug: false, searchQuery: "needle" },
        raw: {
          eventTypes: ["events.iterate.test/one"],
          components: ["raw.group"],
          searchQuery: null,
          offsetFrom: 3,
          offsetTo: 9,
        },
      },
    };

    const parsed = validateStreamFeedReadInput(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.filter?.raw?.eventTypes).not.toBe(input.filter.raw.eventTypes);
  });

  test.each([
    [null, "input must be an object"],
    [{ offset: 0, beforeLocalIndex: 1 }, "accepts offset or beforeLocalIndex"],
    [{ limit: 501 }, "limit must be an integer from 1 to 500"],
    [{ filter: {} }, "filter.agent must be an object or null"],
    [
      { filter: { agent: null, raw: { eventTypes: [], components: null } } },
      "filter.raw.searchQuery must be a string",
    ],
    [
      {
        filter: {
          agent: null,
          raw: {
            eventTypes: new Array(101).fill("type"),
            components: null,
            searchQuery: null,
            offsetFrom: null,
            offsetTo: null,
          },
        },
      },
      "accepts at most 100 values",
    ],
  ])("rejects malformed or unbounded input %#", (input, message) => {
    expect(() => validateStreamFeedReadInput(input)).toThrow(message);
  });
});
