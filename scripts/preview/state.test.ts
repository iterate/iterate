import { describe, expect, it } from "vitest";
import {
  CloudflarePreviewAppEntry,
  CloudflarePreviewEnvironment,
  parseCloudflarePreviewState,
  renderCloudflarePreviewPullRequestBody,
} from "./state.ts";

describe("cloudflare preview state helpers", () => {
  it("round-trips rendered preview state from the managed PR body section", () => {
    const environment = CloudflarePreviewEnvironment.parse({
      dopplerConfig: "preview_1",
      leasedUntil: 1_700_000_000_000,
      leaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
      slug: "preview-1",
      type: "cloudflare-preview-environment",
    });
    const entry = CloudflarePreviewAppEntry.parse({
      appDisplayName: "Example",
      appSlug: "example",
      headSha: "abcdef0123456789",
      publicUrl: "https://example-preview-1.iterate.workers.dev",
      runUrl: "https://github.com/iterate/iterate/actions/runs/123",
      shortSha: "abcdef0",
      status: "deployed",
      updatedAt: "2026-04-02T10:00:00.000Z",
    });

    const state = {
      apps: {
        example: entry,
      },
      environment,
    };
    const body = renderCloudflarePreviewPullRequestBody(
      "## Summary\n\nExisting user-authored description.",
      state,
    );

    expect(parseCloudflarePreviewState(body)).toEqual(state);
    expect(body).toContain("## Summary");
    expect(body).toContain("## Preview Environment");
    expect(body).toContain("Environment: `preview-1`");
    expect(body).toContain("Config: `preview_1`");
    expect(body).toContain("<!-- CLOUDFLARE_PREVIEW_ENVIRONMENTS_STATE -->");
    expect(body).toContain("<!--\n{");
    expect(body).toContain("\n-->\n<!-- /CLOUDFLARE_PREVIEW_ENVIRONMENTS_STATE -->");
    expect(body).toContain("Preview: https://example-preview-1.iterate.workers.dev");
  });

  it("updates only the managed block and preserves surrounding PR body content", () => {
    const initialBody = [
      "# User content",
      "",
      "Owned by humans.",
      "",
      "<!-- CLOUDFLARE_PREVIEW_ENVIRONMENTS -->",
      "old section",
      "<!-- /CLOUDFLARE_PREVIEW_ENVIRONMENTS -->",
      "",
      "Footer",
    ].join("\n");

    const body = renderCloudflarePreviewPullRequestBody(initialBody, {
      apps: {
        events: CloudflarePreviewAppEntry.parse({
          appDisplayName: "Events",
          appSlug: "events",
          message: "AssertionError: expected 2 to be +0",
          runUrl: "https://github.com/iterate/iterate/actions/runs/456",
          shortSha: "1234567",
          status: "tests-failed",
          updatedAt: "2026-04-02T10:00:00.000Z",
        }),
      },
      environment: null,
    });

    expect(body).toContain("# User content");
    expect(body).toContain("Footer");
    expect(body).toContain("No active preview lease.");
    expect(body).toContain("Summary: AssertionError: expected 2 to be +0");
    expect(body).toContain("<details>");
  });

  it("returns empty state when the managed block is deleted", () => {
    expect(parseCloudflarePreviewState("## Summary\n\nNo preview block here.")).toEqual({
      apps: {},
      environment: null,
    });
  });

  it("returns empty state when the managed state block is malformed", () => {
    const body = [
      "## Preview Environment",
      "",
      "<!-- CLOUDFLARE_PREVIEW_ENVIRONMENTS_STATE -->",
      "<!--",
      "{ not json }",
      "-->",
      "<!-- /CLOUDFLARE_PREVIEW_ENVIRONMENTS_STATE -->",
    ].join("\n");

    expect(parseCloudflarePreviewState(body)).toEqual({
      apps: {},
      environment: null,
    });
  });
});
