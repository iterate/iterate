import { describe, expect, test } from "vitest";
import { defaultProjectId, getProjectUrl, resolveHostProjectId } from "./project-id.ts";

describe("project ID host helpers", () => {
  test("resolveHostProjectId reads project subdomains on production and preview hosts", () => {
    expect(resolveHostProjectId("events.iterate.com")).toBeUndefined();
    expect(resolveHostProjectId("team-a.events.iterate.com")).toBe("team-a");
    expect(resolveHostProjectId("events.iterate-preview-10.com")).toBeUndefined();
    expect(resolveHostProjectId("team-a.events.iterate-preview-10.com")).toBe("team-a");
  });

  test("getProjectUrl switches between bare and scoped production hosts", () => {
    expect(
      getProjectUrl({
        currentUrl: "https://events.iterate.com/streams/",
        projectId: "team-a",
      }).toString(),
    ).toBe("https://team-a.events.iterate.com/streams/");

    expect(
      getProjectUrl({
        currentUrl: "https://team-a.events.iterate.com/streams/",
        projectId: defaultProjectId,
      }).toString(),
    ).toBe("https://events.iterate.com/streams/");
  });

  test("getProjectUrl preserves preview host families", () => {
    expect(
      getProjectUrl({
        currentUrl: "https://events.iterate-preview-10.com/streams/",
        projectId: "team-a",
      }).toString(),
    ).toBe("https://team-a.events.iterate-preview-10.com/streams/");

    expect(
      getProjectUrl({
        currentUrl: "https://team-a.events.iterate-preview-10.com/streams/",
        projectId: defaultProjectId,
      }).toString(),
    ).toBe("https://events.iterate-preview-10.com/streams/");
  });

  test("getProjectUrl leaves unrelated hosts unchanged", () => {
    expect(
      getProjectUrl({
        currentUrl: "http://127.0.0.1:5173/streams/",
        projectId: "team-a",
      }).toString(),
    ).toBe("http://127.0.0.1:5173/streams/");
  });
});
