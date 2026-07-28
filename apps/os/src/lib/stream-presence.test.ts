import { describe, expect, it } from "vitest";
import type { AgentUiPresenceEntry } from "@iterate-com/ui/components/events/agent-ui-reducer";
import { presenceLabel } from "./stream-presence.ts";

const browserPresence = (user: { email: string; name?: string }): AgentUiPresenceEntry => ({
  connectionKey: "browser:tab-1",
  connectionKind: "session",
  connected: true,
  description: "browser",
  user,
});

describe("presenceLabel", () => {
  it("prefers an authenticated user's name over the browser processor slug", () => {
    const entry = browserPresence({ email: "jonas@example.com", name: "Jonas Temple" });
    entry.processor = {
      slug: "browser-stream-mirror",
      version: "1",
      description: "Browser stream mirror",
      consumes: [],
      emits: [],
      ownedEvents: [],
    };

    expect(presenceLabel(entry)).toBe("Jonas Temple");
  });

  it("falls back to the authenticated user's email", () => {
    expect(presenceLabel(browserPresence({ email: "jonas@example.com" }))).toBe(
      "jonas@example.com",
    );
  });
});
