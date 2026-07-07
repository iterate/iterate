import { describe, expect, it } from "vitest";
import {
  buildCloudflareContainersDashboardUrl,
  inferOsDopplerConfigForWorkerName,
} from "./cloudflare-containers-dashboard-url.ts";

describe("buildCloudflareContainersDashboardUrl", () => {
  it("links to Cloudflare's account-scoped Containers dashboard", () => {
    expect(
      buildCloudflareContainersDashboardUrl({
        accountId: "04b3b57291ef2626c6a8daa9d47065a7",
      }),
    ).toBe(
      "https://dash.cloudflare.com/?to=%2F04b3b57291ef2626c6a8daa9d47065a7%2Fworkers%2Fcontainers",
    );
  });

  it("returns null without a valid account id", () => {
    expect(buildCloudflareContainersDashboardUrl({ accountId: "" })).toBeNull();
    expect(buildCloudflareContainersDashboardUrl({ accountId: "not-an-account-id" })).toBeNull();
  });
});

describe("inferOsDopplerConfigForWorkerName", () => {
  it("maps deployed OS worker names back to Doppler config names", () => {
    expect(inferOsDopplerConfigForWorkerName("os")).toBe("dev");
    expect(inferOsDopplerConfigForWorkerName("os-prd")).toBe("prd");
    expect(inferOsDopplerConfigForWorkerName("os-preview-3")).toBe("preview_3");
  });

  it("keeps an explicit placeholder for unknown worker names", () => {
    expect(inferOsDopplerConfigForWorkerName()).toBe("<env>");
    expect(inferOsDopplerConfigForWorkerName("custom-os")).toBe("<env>");
  });
});
