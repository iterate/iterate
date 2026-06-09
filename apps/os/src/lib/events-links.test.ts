import { describe, expect, it } from "vitest";
import { eventsStreamViewerUrl, streamsExampleAppViewerUrl } from "./events-links.ts";

describe("events links", () => {
  it("links production OS projects to the streams example app with query params", () => {
    expect(
      eventsStreamViewerUrl({
        currentOrigin: "https://os.iterate.com",
        namespace: "prj_d871bac9722d45aba4e3dbb50057900d",
        streamPath: "/agents/loop",
      }),
    ).toBe(
      "https://os-streams.iterate.workers.dev/streams?path=%2Fagents%2Floop&namespace=prj_d871bac9722d45aba4e3dbb50057900d",
    );
  });

  it("links localhost OS to the local streams example app", () => {
    expect(
      eventsStreamViewerUrl({
        currentOrigin: "http://localhost:5173",
        namespace: "project-123",
        streamPath: "/agents/alice",
      }),
    ).toBe("http://localhost:5173/streams?path=%2Fagents%2Falice&namespace=project-123");
  });

  it("links OS preview projects to the matching Events preview namespace", () => {
    expect(
      eventsStreamViewerUrl({
        currentOrigin: "https://os.iterate-preview-2.com",
        namespace: "project-123",
        streamPath: "/agents/alice/bla",
      }),
    ).toBe("https://project-123.events.iterate-preview-2.com/streams/agents/alice/bla");
  });

  it("encodes stream path segments in the legacy Events viewer", () => {
    expect(
      eventsStreamViewerUrl({
        currentOrigin: "https://os.iterate-preview-2.com",
        namespace: "project-123",
        streamPath: "/spaces and/slashes",
      }),
    ).toBe("https://project-123.events.iterate-preview-2.com/streams/spaces%20and/slashes");
  });

  it("builds streams example app URLs without a namespace param for default", () => {
    expect(
      streamsExampleAppViewerUrl({
        baseUrl: "https://os-streams.iterate.workers.dev",
        namespace: "default",
        streamPath: "/",
      }),
    ).toBe("https://os-streams.iterate.workers.dev/streams?path=%2F");
  });
});
