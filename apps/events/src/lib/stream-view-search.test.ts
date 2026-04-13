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

  test("accepts yaml composer mode", () => {
    expect(validateStreamViewSearch({ composer: "yaml" })).toEqual({
      ...defaultStreamViewSearch,
      composer: "yaml",
    });
  });

  test("accepts raw renderer mode", () => {
    expect(validateStreamViewSearch({ renderer: "raw" })).toEqual({
      ...defaultStreamViewSearch,
      renderer: "raw",
    });
  });

  test("accepts raw-single-json renderer mode", () => {
    expect(validateStreamViewSearch({ renderer: "raw-single-json" })).toEqual({
      ...defaultStreamViewSearch,
      renderer: "raw-single-json",
    });
  });

  test("falls back to default for old 'raw' composer value", () => {
    expect(validateStreamViewSearch({ composer: "raw" })).toEqual(defaultStreamViewSearch);
  });
});
