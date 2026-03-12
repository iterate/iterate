import { describe, expect, it } from "vitest";
import { prefixTitleWithRawTags, test } from "./e2e-test.ts";

describe("prefixTitleWithRawTags", () => {
  it("prefixes raw tags when tags are present", () => {
    expect(
      prefixTitleWithRawTags("records and replays traffic", {
        tags: ["docker", "no-internet"],
      }),
    ).toBe("[docker no-internet] records and replays traffic");
  });

  it("leaves titles unchanged when tags are absent", () => {
    expect(prefixTitleWithRawTags("records and replays traffic")).toBe(
      "records and replays traffic",
    );
  });

  it("preserves multiple tags in order", () => {
    expect(
      prefixTitleWithRawTags("runs slowly", {
        tags: ["fly", "slow", "third-party"],
      }),
    ).toBe("[fly slow third-party] runs slowly");
  });

  it("accepts a single string tag", () => {
    expect(
      prefixTitleWithRawTags("runs through public ingress", {
        tags: "docker",
      }),
    ).toBe("[docker] runs through public ingress");
  });
});

describe("exported test wrapper", () => {
  it("preserves static vitest helpers", () => {
    expect(typeof test.skip).toBe("function");
    expect(typeof test.only).toBe("function");
    expect(typeof test.each).toBe("function");
  });
});
