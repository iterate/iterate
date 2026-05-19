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
});
