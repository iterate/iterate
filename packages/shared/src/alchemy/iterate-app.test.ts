import { describe, expect, it } from "vitest";
import { selectBestCloudflareZoneForHostname } from "./iterate-app.ts";

describe("selectBestCloudflareZoneForHostname", () => {
  it("prefers an active delegated zone over a moved zone in the configured account", () => {
    expect(
      selectBestCloudflareZoneForHostname({
        accountId: "preview-account",
        hostname: "os.iterate-preview-2.com",
        zones: [
          {
            account: { id: "preview-account" },
            id: "moved-zone",
            name: "iterate-preview-2.com",
            status: "moved",
          },
          {
            account: { id: "delegated-account" },
            id: "active-zone",
            name: "iterate-preview-2.com",
            status: "active",
          },
        ],
      })?.id,
    ).toBe("active-zone");
  });

  it("still prefers an active zone in the configured account when one exists", () => {
    expect(
      selectBestCloudflareZoneForHostname({
        accountId: "preview-account",
        hostname: "*.iterate-preview-2.app",
        zones: [
          {
            account: { id: "other-account" },
            id: "other-active-zone",
            name: "iterate-preview-2.app",
            status: "active",
          },
          {
            account: { id: "preview-account" },
            id: "preview-active-zone",
            name: "iterate-preview-2.app",
            status: "active",
          },
        ],
      })?.id,
    ).toBe("preview-active-zone");
  });
});
