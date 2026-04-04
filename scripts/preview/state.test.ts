import { describe, expect, it } from "vitest";
import {
  clearCloudflarePreviewDestroyPayload,
  CloudflarePreviewEntry,
  parseCloudflarePreviewState,
  renderCloudflarePreviewPullRequestBody,
} from "./state.ts";

describe("cloudflare preview state helpers", () => {
  it("round-trips rendered preview state from the managed PR body section", () => {
    const entry = CloudflarePreviewEntry.parse({
      appDisplayName: "Example",
      appSlug: "example",
      headSha: "abcdef0123456789",
      leasedUntil: 1_700_000_000_000,
      previewEnvironmentAlchemyStageName: "preview-1",
      previewEnvironmentDopplerConfigName: "stg_1",
      previewEnvironmentIdentifier: "example-preview-1",
      previewEnvironmentSemaphoreLeaseId: "9d975621-72c8-459d-936d-e9b4335e0f5d",
      previewEnvironmentSlug: "example-preview-1",
      previewEnvironmentType: "example-preview-environment",
      publicUrl: "https://example-preview-1.iterate.workers.dev",
      runUrl: "https://github.com/iterate/iterate/actions/runs/123",
      shortSha: "abcdef0",
      status: "deployed",
      updatedAt: "2026-04-02T10:00:00.000Z",
    });

    const body = renderCloudflarePreviewPullRequestBody(
      "## Summary\n\nExisting user-authored description.",
      {
        example: entry,
      },
    );

    expect(parseCloudflarePreviewState(body)).toEqual({
      example: entry,
    });
    expect(body).toContain("## Summary");
    expect(body).toContain("## Preview Environments");
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
      events: CloudflarePreviewEntry.parse({
        appDisplayName: "Events",
        appSlug: "events",
        message: "\u001b[31mAssertionError: expected 2 to be +0\u001b[39m",
        runUrl: "https://github.com/iterate/iterate/actions/runs/456",
        shortSha: "1234567",
        status: "tests-failed",
        updatedAt: "2026-04-02T10:00:00.000Z",
      }),
    });

    expect(body).toContain("# User content");
    expect(body).toContain("Footer");
    expect(body).toContain("Summary: AssertionError: expected 2 to be +0");
    expect(body).not.toContain("\u001b[31m");
    expect(body).toContain("<details>");
  });

  it("returns empty state when the managed block is deleted", () => {
    expect(parseCloudflarePreviewState("## Summary\n\nNo preview block here.")).toEqual({});
  });

  it("clears destroy payload fields after release", () => {
    const entry = CloudflarePreviewEntry.parse({
      appDisplayName: "Semaphore",
      appSlug: "semaphore",
      leasedUntil: 1_700_000_000_000,
      message: "Preview environment released.",
      previewEnvironmentAlchemyStageName: "preview-2",
      previewEnvironmentDopplerConfigName: "stg_2",
      previewEnvironmentIdentifier: "semaphore-preview-2",
      previewEnvironmentSemaphoreLeaseId: "8225d390-269b-4428-bb11-03d4fd09ff4d",
      previewEnvironmentSlug: "semaphore-preview-2",
      previewEnvironmentType: "semaphore-preview-environment",
      publicUrl: "https://semaphore-preview-2.iterate.workers.dev",
      runUrl: "https://github.com/iterate/iterate/actions/runs/456",
      shortSha: "1234567",
      status: "released",
      updatedAt: "2026-04-02T10:00:00.000Z",
    });

    expect(clearCloudflarePreviewDestroyPayload(entry)).toEqual({
      ...entry,
      leasedUntil: null,
      previewEnvironmentAlchemyStageName: null,
      previewEnvironmentDopplerConfigName: null,
      previewEnvironmentIdentifier: null,
      previewEnvironmentSemaphoreLeaseId: null,
      previewEnvironmentSlug: null,
      previewEnvironmentType: null,
    });
  });
});
