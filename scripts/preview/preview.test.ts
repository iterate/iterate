import { describe, expect, it } from "vitest";
import { isSupportedPreviewEnvironmentSlug } from "./preview.ts";

describe("preview environment selection", () => {
  it("skips excluded preview slots", () => {
    expect(
      isSupportedPreviewEnvironmentSlug({
        appSlug: "os2",
        excludedPreviewSlots: [1],
        slug: "os2-preview-1",
      }),
    ).toBe(false);
    expect(
      isSupportedPreviewEnvironmentSlug({
        appSlug: "os2",
        excludedPreviewSlots: [1],
        slug: "os2-preview-2",
      }),
    ).toBe(true);
  });

  it("does not exclude slots without app config", () => {
    expect(isSupportedPreviewEnvironmentSlug({ appSlug: "events", slug: "events-preview-1" })).toBe(
      true,
    );
  });

  it("rejects slugs that do not belong to the app", () => {
    expect(isSupportedPreviewEnvironmentSlug({ appSlug: "events", slug: "os2-preview-2" })).toBe(
      false,
    );
  });
});
