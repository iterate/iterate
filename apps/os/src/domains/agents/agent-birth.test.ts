import { describe, expect, it } from "vitest";
import { agentBirthEvents } from "./agent-birth.ts";

const processorSlugs = (agentPath: string) =>
  agentBirthEvents({ agentPath, projectId: "prj_test" })
    .filter((event) => event.type === "events.iterate.com/stream/subscription-configured")
    .map((event) => event.payload.delivery.processorSlug);

describe("agent birth certificate", () => {
  it("declares a routed web agent's root ancestor and core processors", () => {
    const events = agentBirthEvents({
      agentPath: "/agents/web/thread",
      projectId: "prj_test",
    });

    expect(events[0]).toMatchObject({
      type: "events.iterate.com/capability-host/ancestor-configured",
      payload: { ancestorPath: "/" },
    });
    expect(processorSlugs("/agents/web/thread")).toEqual(["capability-host", "agent"]);
  });

  it("declares a real child agent's immediate agent ancestor", () => {
    const events = agentBirthEvents({
      agentPath: "/agents/web/thread/researcher",
      projectId: "prj_test",
    });

    expect(events[0].payload).toEqual({ ancestorPath: "/agents/web/thread" });
    expect(processorSlugs("/agents/web/thread/researcher")).toEqual(["capability-host", "agent"]);
  });

  it("installs a routed leaf transcriber but never leaks it to child agents", () => {
    const routed = "/agents/slack/main/C123/ts-123-456";

    expect(processorSlugs(routed)).toEqual(["capability-host", "agent", "slack-agent"]);
    expect(processorSlugs(`${routed}/researcher`)).toEqual(["capability-host", "agent"]);
  });
});
