import { describe, expect, it } from "vitest";
import { buildProjectStreamViewerUrl, projectStreamViewerPathname } from "./stream-viewer-url.ts";

describe("stream viewer URLs", () => {
  it("builds dashboard stream links on the configured app base URL", () => {
    expect(
      buildProjectStreamViewerUrl({
        baseUrl: "https://os.iterate-dev-jonas.com",
        projectSlug: "test",
        streamPath: "/integrations/slack",
      }),
    ).toBe("https://os.iterate-dev-jonas.com/projects/test/streams/integrations/slack");
  });

  it("encodes route params and stream path segments", () => {
    expect(
      projectStreamViewerPathname({
        projectSlug: "project/slash",
        streamPath: "/spaces and/slashes",
      }),
    ).toBe("/projects/project%2Fslash/streams/spaces%20and/slashes");
  });

  it("links the root stream to the %2F splat, not the streams index", () => {
    expect(
      buildProjectStreamViewerUrl({
        baseUrl: "https://os.iterate.com",
        projectSlug: "test",
        streamPath: "/",
      }),
    ).toBe("https://os.iterate.com/projects/test/streams/%2F");
  });
});
