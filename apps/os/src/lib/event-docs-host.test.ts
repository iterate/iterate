import { describe, expect, it } from "vitest";
import { eventDocsHostnameForAppBaseUrl, isEventDocsHostname } from "~/lib/event-docs-host.ts";

describe("event docs host", () => {
  it("derives the production event docs host from the OS production host", () => {
    expect(eventDocsHostnameForAppBaseUrl("https://os.iterate.com")).toBe("events.iterate.com");
  });

  it("derives sibling event docs hosts for preview and dev OS hosts", () => {
    expect(eventDocsHostnameForAppBaseUrl("https://os.iterate-preview-3.com")).toBe(
      "events.iterate-preview-3.com",
    );
    expect(eventDocsHostnameForAppBaseUrl("https://os.iterate-dev-jonas.com")).toBe(
      "events.iterate-dev-jonas.com",
    );
  });

  it("does not derive a routed event docs host for localhost", () => {
    expect(eventDocsHostnameForAppBaseUrl("http://localhost:5173")).toBeNull();
  });

  it("recognizes the configured event docs request host", () => {
    expect(
      isEventDocsHostname({
        appBaseUrl: "https://os.iterate-preview-3.com",
        requestUrl: "https://events.iterate-preview-3.com/stream",
      }),
    ).toBe(true);
  });
});
