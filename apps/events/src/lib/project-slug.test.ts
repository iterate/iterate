import { describe, expect, test } from "vitest";
import { defaultProjectSlug, getProjectUrl, resolveHostProjectSlug } from "./project-slug.ts";

describe("project slug host helpers", () => {
  test("resolveHostProjectSlug reads project subdomains on production and preview hosts", () => {
    expect(resolveHostProjectSlug("events.iterate.com")).toBeUndefined();
    expect(resolveHostProjectSlug("team-a.events.iterate.com")).toBe("team-a");
    expect(resolveHostProjectSlug("events-preview-10.iterate.com")).toBeUndefined();
    expect(resolveHostProjectSlug("team-a.events-preview-10.iterate.com")).toBe("team-a");
  });

  test("getProjectUrl switches between bare and scoped production hosts", () => {
    expect(
      getProjectUrl({
        currentUrl: "https://events.iterate.com/streams/",
        projectSlug: "team-a",
      }).toString(),
    ).toBe("https://team-a.events.iterate.com/streams/");

    expect(
      getProjectUrl({
        currentUrl: "https://team-a.events.iterate.com/streams/",
        projectSlug: defaultProjectSlug,
      }).toString(),
    ).toBe("https://events.iterate.com/streams/");
  });

  test("getProjectUrl preserves preview host families", () => {
    expect(
      getProjectUrl({
        currentUrl: "https://events-preview-10.iterate.com/streams/",
        projectSlug: "team-a",
      }).toString(),
    ).toBe("https://team-a.events-preview-10.iterate.com/streams/");

    expect(
      getProjectUrl({
        currentUrl: "https://team-a.events-preview-10.iterate.com/streams/",
        projectSlug: defaultProjectSlug,
      }).toString(),
    ).toBe("https://events-preview-10.iterate.com/streams/");
  });

  test("getProjectUrl leaves unrelated hosts unchanged", () => {
    expect(
      getProjectUrl({
        currentUrl: "http://127.0.0.1:5173/streams/",
        projectSlug: "team-a",
      }).toString(),
    ).toBe("http://127.0.0.1:5173/streams/");
  });
});
