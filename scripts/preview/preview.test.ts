import { describe, expect, it } from "vitest";
import { expandPreviewDependencies } from "./preview.ts";

describe("preview app dependency expansion", () => {
  it("adds explicit dependencies for affected apps", () => {
    expect(expandPreviewDependencies(["os2"])).toEqual(["events", "os2"]);
  });

  it("keeps independent apps as-is", () => {
    expect(expandPreviewDependencies(["events"])).toEqual(["events"]);
  });

  it("deduplicates dependencies", () => {
    expect(expandPreviewDependencies(["events", "os2"])).toEqual(["events", "os2"]);
  });
});
