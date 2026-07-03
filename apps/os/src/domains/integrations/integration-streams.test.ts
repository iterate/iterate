import { describe, expect, test } from "vitest";
import type { StreamEvent } from "../../types.ts";
import { foldSlackTeamDirectory } from "./integration-streams.ts";
import { SLACK_TEAM_CLAIMED_EVENT_TYPE, SLACK_TEAM_UNCLAIMED_EVENT_TYPE } from "./utils.ts";

let offset = 0;
function event(type: string, payload: Record<string, unknown>): StreamEvent {
  offset += 1;
  return { createdAt: new Date().toISOString(), offset, payload, type } as StreamEvent;
}

describe("foldSlackTeamDirectory", () => {
  test("latest claim wins; a matching unclaim clears it", () => {
    const claims = foldSlackTeamDirectory([
      event(SLACK_TEAM_CLAIMED_EVENT_TYPE, {
        connection: "acme",
        projectId: "prj_1",
        teamId: "T1",
      }),
      event(SLACK_TEAM_UNCLAIMED_EVENT_TYPE, {
        connection: "acme",
        projectId: "prj_1",
        teamId: "T1",
      }),
    ]);
    expect(claims.size).toBe(0);
  });

  test("a stale connection's unclaim cannot tear down the team's live claim under a new name", () => {
    // Team T1 was connected as "acme", disconnected, then reconnected after a
    // workspace domain change as "newco". Disconnecting the leftover "acme"
    // row must not unroute the healthy "newco" claim.
    const claims = foldSlackTeamDirectory([
      event(SLACK_TEAM_CLAIMED_EVENT_TYPE, {
        connection: "acme",
        projectId: "prj_1",
        teamId: "T1",
      }),
      event(SLACK_TEAM_CLAIMED_EVENT_TYPE, {
        connection: "newco",
        projectId: "prj_1",
        teamId: "T1",
      }),
      event(SLACK_TEAM_UNCLAIMED_EVENT_TYPE, {
        connection: "acme",
        projectId: "prj_1",
        teamId: "T1",
      }),
    ]);
    expect(claims.get("T1")).toEqual({ connection: "newco", projectId: "prj_1" });
  });

  test("another project's unclaim never clears a claim; claims without a connection are ignored", () => {
    const claims = foldSlackTeamDirectory([
      event(SLACK_TEAM_CLAIMED_EVENT_TYPE, { projectId: "prj_1", teamId: "T0" }), // pre-connections: ignored
      event(SLACK_TEAM_CLAIMED_EVENT_TYPE, {
        connection: "acme",
        projectId: "prj_1",
        teamId: "T1",
      }),
      event(SLACK_TEAM_UNCLAIMED_EVENT_TYPE, {
        connection: "acme",
        projectId: "prj_2",
        teamId: "T1",
      }),
    ]);
    expect(claims.has("T0")).toBe(false);
    expect(claims.get("T1")).toEqual({ connection: "acme", projectId: "prj_1" });
  });
});
