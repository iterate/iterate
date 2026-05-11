import { describe, expect, it } from "vitest";
import { eventsStreamViewerUrl } from "./events-links.ts";

describe("events links", () => {
  it("links OS2 preview projects to the matching Events preview namespace", () => {
    expect(
      eventsStreamViewerUrl({
        currentOrigin: "https://os2.iterate-preview-2.com",
        namespace: "project-123",
        streamPath: "/agents/alice/bla",
      }),
    ).toBe("https://project-123.events.iterate-preview-2.com/streams/agents/alice/bla");
  });

  it("links production projects to events.iterate.com", () => {
    expect(
      eventsStreamViewerUrl({
        currentOrigin: "https://os2.iterate.com",
        namespace: "project-123",
        streamPath: "/",
      }),
    ).toBe("https://project-123.events.iterate.com/streams/");
  });

  it("encodes stream path segments", () => {
    expect(
      eventsStreamViewerUrl({
        namespace: "project-123",
        streamPath: "/spaces and/slashes",
      }),
    ).toBe("https://project-123.events.iterate.com/streams/spaces%20and/slashes");
  });
});
