import { describe, expect, it } from "vitest";
import {
  CloudflarePreviewAppEntry,
  EnvironmentConfigLease,
  parseCloudflarePreviewState,
  renderCloudflarePreviewPullRequestBody,
} from "./state.ts";

describe("cloudflare preview state helpers", () => {
  it("round-trips rendered preview state from the managed PR body section", () => {
    const environmentConfigLease = EnvironmentConfigLease.parse({
      dopplerConfig: "preview_2",
      leasedUntil: 1_700_000_000_000,
      leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
      slug: "preview-2",
      type: "environment-config-lease",
    });
    const entry = CloudflarePreviewAppEntry.parse({
      appDisplayName: "Example",
      appSlug: "example",
      headSha: "abcdef0123456789",
      publicUrl: "https://example-preview-2.iterate.workers.dev",
      runUrl: "https://github.com/iterate/iterate/actions/runs/123",
      shortSha: "abcdef0",
      status: "deployed",
      updatedAt: "2026-04-02T10:00:00.000Z",
    });

    const state = {
      apps: {
        example: entry,
      },
      environmentConfigLease,
    };
    const body = renderCloudflarePreviewPullRequestBody(
      "## Summary\n\nExisting user-authored description.",
      state,
    );

    expect(parseCloudflarePreviewState(body)).toEqual(state);
    expect(body).toContain("## Summary");
    expect(body).toContain("## Environment Config Lease");
    expect(body).toContain("Lease: `preview-2`");
    expect(body).toContain("Doppler config: `preview_2`");
    expect(body).toContain("<!-- CLOUDFLARE_PREVIEW_STATE -->");
    expect(body).toContain("<!--\n{");
    expect(body).toContain("\n-->\n<!-- /CLOUDFLARE_PREVIEW_STATE -->");
    expect(body).toContain("Preview: https://example-preview-2.iterate.workers.dev");
  });

  it("updates only the managed block and preserves surrounding PR body content", () => {
    const initialBody = [
      "# User content",
      "",
      "Owned by humans.",
      "",
      "<!-- CLOUDFLARE_PREVIEW -->",
      "old section",
      "<!-- /CLOUDFLARE_PREVIEW -->",
      "",
      "Footer",
    ].join("\n");

    const body = renderCloudflarePreviewPullRequestBody(initialBody, {
      apps: {
        os: CloudflarePreviewAppEntry.parse({
          appDisplayName: "OS",
          appSlug: "os",
          message: "AssertionError: expected 2 to be +0",
          runUrl: "https://github.com/iterate/iterate/actions/runs/456",
          shortSha: "1234567",
          status: "tests-failed",
          updatedAt: "2026-04-02T10:00:00.000Z",
        }),
      },
      environmentConfigLease: null,
    });

    expect(body).toContain("# User content");
    expect(body).toContain("Footer");
    expect(body).toContain("No active environment config lease.");
    expect(body).toContain("Summary: AssertionError: expected 2 to be +0");
    expect(body).toContain("<details>");
  });

  it("returns empty state when the managed block is deleted", () => {
    expect(parseCloudflarePreviewState("## Summary\n\nNo preview block here.")).toEqual({
      apps: {},
      environmentConfigLease: null,
    });
  });

  it("returns empty state when the managed state block is malformed", () => {
    const body = [
      "## Environment Config Lease",
      "",
      "<!-- CLOUDFLARE_PREVIEW_STATE -->",
      "<!--",
      "{ not json }",
      "-->",
      "<!-- /CLOUDFLARE_PREVIEW_STATE -->",
    ].join("\n");

    expect(parseCloudflarePreviewState(body)).toEqual({
      apps: {},
      environmentConfigLease: null,
    });
  });
});
