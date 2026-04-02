import { describe, expect, it } from "vitest";
import {
  clearCloudflarePreviewDestroyPayload,
  cloudflarePreviewCommentMarker,
  CloudflarePreviewCommentEntry,
  findLatestManagedCloudflarePreviewComment,
  parseCloudflarePreviewCommentState,
  renderCloudflarePreviewCommentBody,
} from "./cloudflare-preview-comment.ts";

describe("cloudflare preview comment helpers", () => {
  it("round-trips rendered preview comment state", () => {
    const entry = CloudflarePreviewCommentEntry.parse({
      appDisplayName: "Example",
      appSlug: "example",
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

    const body = renderCloudflarePreviewCommentBody(
      {
        example: entry,
      },
      "example",
    );

    expect(parseCloudflarePreviewCommentState(body, "example")).toEqual({
      example: entry,
    });
    expect(body).toContain("### Example");
    expect(body).toContain("Environment: `example-preview-1`");
  });

  it("clears destroy payload fields after release", () => {
    const entry = CloudflarePreviewCommentEntry.parse({
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

  it("ignores human-authored preview comments when selecting managed state", () => {
    const managed = findLatestManagedCloudflarePreviewComment(
      [
        {
          body: `${cloudflarePreviewCommentMarker("example")}\nold`,
          id: 1,
          user: {
            login: "github-actions[bot]",
          },
        },
        {
          body: `${cloudflarePreviewCommentMarker("example")}\nnewer but human`,
          id: 2,
          user: {
            login: "jonastemplestein",
          },
        },
      ],
      "example",
    );

    expect(managed?.id).toBe(1);
  });

  it("selects the managed comment for the requested app only", () => {
    const managed = findLatestManagedCloudflarePreviewComment(
      [
        {
          body: `${cloudflarePreviewCommentMarker("events")}\nevents`,
          id: 1,
          user: {
            login: "github-actions[bot]",
          },
        },
        {
          body: `${cloudflarePreviewCommentMarker("example")}\nexample`,
          id: 2,
          user: {
            login: "github-actions[bot]",
          },
        },
      ],
      "example",
    );

    expect(managed?.id).toBe(2);
  });
});
