import { describe, expect, test } from "vitest";
import { defaultStreamViewSearch, validateStreamViewSearch } from "~/lib/stream-view-search.ts";

describe("validateStreamViewSearch", () => {
  test("applies defaults for renderer, composer, and event", () => {
    expect(validateStreamViewSearch({})).toEqual(defaultStreamViewSearch);
  });

  test("parses composer and event from search params", () => {
    expect(validateStreamViewSearch({ composer: "agent", event: "12" })).toEqual({
      ...defaultStreamViewSearch,
      composer: "agent",
      event: 12,
    });
  });
});
