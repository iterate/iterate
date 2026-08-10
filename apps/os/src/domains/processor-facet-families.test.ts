import { describe, expect, it } from "vitest";
import { facetProcessorFamilyForPath } from "./processor-facet-families.ts";

describe("facetProcessorFamilyForPath", () => {
  it("mirrors the facet composition's path dispatch", () => {
    const family = (path: string) => facetProcessorFamilyForPath({ path, projectId: "proj_1" });
    expect(family("/")).toBe("project-root");
    expect(family("/agents")).toBe("agent-collection");
    expect(family("/agents/reviewer")).toBe("agent");
    expect(family("/integrations/email")).toBe("email-router");
    expect(family("/integrations/slack/conn-1")).toBe("slack-router");
    expect(family("/integrations/telegram/conn-1")).toBe("telegram-router");
    expect(family("/devices/device-1")).toBe("device");
    expect(family("/secrets/api-key")).toBe("secret");
    expect(family("/workspaces/main")).toBe("workspace");
    // Repos are the ELSE arm: any unclaimed path can host one.
    expect(family("/repos/config")).toBe("repo");
    expect(family("/examples/guestbook")).toBe("repo");
  });

  it("gives deployment-global streams to repos only", () => {
    expect(facetProcessorFamilyForPath({ path: "/agents/x", projectId: null })).toBe("repo");
  });
});
