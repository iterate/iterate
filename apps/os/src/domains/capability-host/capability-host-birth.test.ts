import { describe, expect, it } from "vitest";
import { capabilityHostBirthEvents } from "./capability-host-birth.ts";

describe("capability host birth certificate", () => {
  it("commits one explicit ancestor before arming the host processor", () => {
    const events = capabilityHostBirthEvents({
      ancestorPath: "/",
      path: "/agents/web/thread",
      projectId: "prj_test",
    });

    expect(events.map((event) => event.type)).toEqual([
      "events.iterate.com/capability-host/ancestor-configured",
      "events.iterate.com/stream/subscription-configured",
    ]);
    expect(events[0].payload).toEqual({ ancestorPath: "/" });
    expect(events[1].payload.delivery.expression).toEqual([
      "capabilityHosts",
      ["get", "/agents/web/thread"],
      "processor",
      "wakeStreamSubscriber",
    ]);
  });

  it("requires root termination to be explicit", () => {
    expect(
      capabilityHostBirthEvents({ ancestorPath: null, path: "/", projectId: "prj_test" })[0]
        .payload,
    ).toEqual({ ancestorPath: null });
  });

  it("rejects a self-cycle at the declaration boundary", () => {
    expect(() =>
      capabilityHostBirthEvents({
        ancestorPath: "/agents/a",
        path: "/agents/a",
        projectId: "prj_test",
      }),
    ).toThrow('capability-host "/agents/a" cannot be its own ancestor');
  });
});
