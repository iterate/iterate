import { describe, expect, test } from "vitest";
import { StreamPath } from "@iterate-com/events-contract";
import { streamPathFromPathname, streamPathFromSplat } from "~/lib/stream-links.ts";

describe("StreamPath", () => {
  test("adds a leading slash to non-root stream paths", () => {
    expect(StreamPath.parse("smoke/mndlvia4")).toBe("/smoke/mndlvia4");
  });

  test("decodes url-encoded slashes before validating the path", () => {
    expect(StreamPath.parse("bla%2Fbanana")).toBe("/bla/banana");
  });

  test("still rejects non-canonical segments like uppercase names", () => {
    expect(() => StreamPath.parse("Bla")).toThrow();
    expect(() => StreamPath.parse("/Bla")).toThrow();
  });
});

describe("streamPathFromSplat", () => {
  test("normalizes trailing slashes from routed stream paths", () => {
    expect(streamPathFromSplat("smoke/mndlvia4/")).toBe("/smoke/mndlvia4");
  });

  test("decodes url-encoded slashes from routed stream paths", () => {
    expect(streamPathFromSplat("bla%2Fbanana")).toBe("/bla/banana");
  });
});

describe("streamPathFromPathname", () => {
  test("normalizes trailing slashes in stream URLs", () => {
    expect(streamPathFromPathname("/streams/smoke/mndlvia4/")).toBe("/smoke/mndlvia4");
  });

  test("returns root for the root streams URL", () => {
    expect(streamPathFromPathname("/streams/")).toBe("/");
  });
});
