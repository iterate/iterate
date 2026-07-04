import { describe, expect, it } from "vitest";
import {
  buildArtifactViewerUrl,
  buildCloudflareArtifactDashboardUrl,
} from "./artifact-viewer-url.ts";

describe("buildArtifactViewerUrl", () => {
  it("derives the artifact viewer host from the OS app base URL", () => {
    expect(
      buildArtifactViewerUrl({
        appBaseUrl: "https://os.iterate-preview-3.com",
        artifactName: "proj__os__01krnehrkefqdrpxksbm9t4kxy--project",
      }),
    ).toBe(
      "https://os-artifacts.iterate-preview-3.com/proj__os__01krnehrkefqdrpxksbm9t4kxy--project",
    );
  });

  it("handles preview hostnames", () => {
    expect(
      buildArtifactViewerUrl({
        appBaseUrl: "https://os.iterate-preview-3.com",
        artifactName: "iterate-config-base",
      }),
    ).toBe("https://os-artifacts.iterate-preview-3.com/iterate-config-base");
  });

  it("returns null without a usable app base URL", () => {
    expect(
      buildArtifactViewerUrl({
        artifactName: "iterate-config-base",
      }),
    ).toBeNull();
  });

  it("still constructs a localhost artifact viewer URL", () => {
    expect(
      buildArtifactViewerUrl({
        appBaseUrl: "http://localhost:5173",
        artifactName: "iterate-config-base",
      }),
    ).toBe("http://os-artifacts.localhost:5173/iterate-config-base");
  });
});

describe("buildCloudflareArtifactDashboardUrl", () => {
  it("links directly to Cloudflare's artifact repo file listing", () => {
    expect(
      buildCloudflareArtifactDashboardUrl({
        accountId: "04b3b57291ef2626c6a8daa9d47065a7",
        artifactName: "app-todo-app",
      }),
    ).toBe(
      "https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers/artifacts/namespaces/default/repos/app-todo-app",
    );
  });

  it("encodes artifact names and supports non-default namespaces", () => {
    expect(
      buildCloudflareArtifactDashboardUrl({
        accountId: "04b3b57291ef2626c6a8daa9d47065a7",
        artifactName: "proj__os__01krnehrkefqdrpxksbm9t4kxy--project",
        namespace: "preview.repos",
      }),
    ).toBe(
      "https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/workers/artifacts/namespaces/preview.repos/repos/proj__os__01krnehrkefqdrpxksbm9t4kxy--project",
    );
  });

  it("returns null without a valid Cloudflare account ID", () => {
    expect(
      buildCloudflareArtifactDashboardUrl({
        accountId: "",
        artifactName: "app-todo-app",
      }),
    ).toBeNull();
    expect(
      buildCloudflareArtifactDashboardUrl({
        accountId: "not-an-account-id",
        artifactName: "app-todo-app",
      }),
    ).toBeNull();
  });
});
