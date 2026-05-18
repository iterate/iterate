import { describe, expect, it } from "vitest";
import { buildArtifactViewerUrl } from "./artifact-viewer-url.ts";

describe("buildArtifactViewerUrl", () => {
  it("derives the artifact viewer host from the OS app base URL", () => {
    expect(
      buildArtifactViewerUrl({
        appBaseUrl: "https://os.iterate-dev-jonas.com",
        artifactName: "proj__os__01krnehrkefqdrpxksbm9t4kxy--iterate-config",
      }),
    ).toBe(
      "https://os-artifacts.iterate-dev-jonas.com/proj__os__01krnehrkefqdrpxksbm9t4kxy--iterate-config",
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
