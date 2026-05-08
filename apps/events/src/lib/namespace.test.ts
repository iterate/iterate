import { describe, expect, test } from "vitest";
import { defaultNamespace, getNamespaceUrl, resolveHostNamespace } from "./namespace.ts";

describe("namespace host helpers", () => {
  test("resolveHostNamespace reads namespace subdomains on production and preview hosts", () => {
    expect(resolveHostNamespace("events.iterate.com")).toBeUndefined();
    expect(resolveHostNamespace("team-a.events.iterate.com")).toBe("team-a");
    expect(resolveHostNamespace("events.iterate-preview-10.com")).toBeUndefined();
    expect(resolveHostNamespace("team-a.events.iterate-preview-10.com")).toBe("team-a");
  });

  test("getNamespaceUrl switches between bare and scoped production hosts", () => {
    expect(
      getNamespaceUrl({
        currentUrl: "https://events.iterate.com/streams/",
        namespace: "team-a",
      }).toString(),
    ).toBe("https://team-a.events.iterate.com/streams/");

    expect(
      getNamespaceUrl({
        currentUrl: "https://team-a.events.iterate.com/streams/",
        namespace: defaultNamespace,
      }).toString(),
    ).toBe("https://events.iterate.com/streams/");
  });

  test("getNamespaceUrl preserves preview host families", () => {
    expect(
      getNamespaceUrl({
        currentUrl: "https://events.iterate-preview-10.com/streams/",
        namespace: "team-a",
      }).toString(),
    ).toBe("https://team-a.events.iterate-preview-10.com/streams/");

    expect(
      getNamespaceUrl({
        currentUrl: "https://team-a.events.iterate-preview-10.com/streams/",
        namespace: defaultNamespace,
      }).toString(),
    ).toBe("https://events.iterate-preview-10.com/streams/");
  });

  test("getNamespaceUrl leaves unrelated hosts unchanged", () => {
    expect(
      getNamespaceUrl({
        currentUrl: "http://127.0.0.1:5173/streams/",
        namespace: "team-a",
      }).toString(),
    ).toBe("http://127.0.0.1:5173/streams/");
  });
});
