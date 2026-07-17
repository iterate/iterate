import { describe, expect, it } from "vitest";
import {
  buildCloudflareContainersDashboardUrl,
  cloudflareContainerApplicationName,
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

  it("deep-links to one container instance when both Cloudflare ids are valid", () => {
    expect(
      buildCloudflareContainersDashboardUrl({
        accountId: "04b3b57291ef2626c6a8daa9d47065a7",
        applicationId: "a038a836-8b44-4fb3-aa69-810bebab29fd",
        instanceId: "a".repeat(64),
      }),
    ).toBe(
      "https://dash.cloudflare.com/?to=%2F04b3b57291ef2626c6a8daa9d47065a7%2Fworkers%2Fcontainers%2Fapplications%2Fa038a836-8b44-4fb3-aa69-810bebab29fd%2Finstances%2Faaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("falls back to the account container list for incomplete instance ids", () => {
    expect(
      buildCloudflareContainersDashboardUrl({
        accountId: "04b3b57291ef2626c6a8daa9d47065a7",
        applicationId: "a038a836-8b44-4fb3-aa69-810bebab29fd",
      }),
    ).toBe(
      "https://dash.cloudflare.com/?to=%2F04b3b57291ef2626c6a8daa9d47065a7%2Fworkers%2Fcontainers",
    );
  });
});

describe("cloudflareContainerApplicationName", () => {
  it("matches Wrangler's generated names in every OS environment", () => {
    expect(
      cloudflareContainerApplicationName({
        className: "SandboxLiteDurableObject",
        workerName: "os",
      }),
    ).toBe("os-sandboxlitedurableobject");
    expect(
      cloudflareContainerApplicationName({
        className: "SandboxLiteDurableObject",
        workerName: "os-prd",
      }),
    ).toBe("os-prd-sandboxlitedurableobject-prd");
    expect(
      cloudflareContainerApplicationName({
        className: "SandboxLiteDurableObject",
        workerName: "os-preview-3",
      }),
    ).toBe("os-preview-3-sandboxlitedurableobject-preview-3");
  });

  it("does not guess application names for unknown workers", () => {
    expect(
      cloudflareContainerApplicationName({
        className: "SandboxLiteDurableObject",
        workerName: "custom-os",
      }),
    ).toBeNull();
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
