import { describe, expect, test } from "vitest";
import type { StreamEvent } from "iterate/processors";
import { foldConnectionDirectory } from "./integration-streams.ts";
import { CONNECTION_CLAIMED_EVENT_TYPE, CONNECTION_UNCLAIMED_EVENT_TYPE } from "./utils.ts";

let offset = 0;
function event(type: string, payload: Record<string, unknown>): StreamEvent {
  offset += 1;
  return { createdAt: new Date().toISOString(), offset, payload, type } as StreamEvent;
}

const claim = (slug: string, externalId: string, projectId: string, connection: string) =>
  event(CONNECTION_CLAIMED_EVENT_TYPE, { connection, externalId, projectId, slug });
const unclaim = (slug: string, externalId: string, projectId: string, connection: string) =>
  event(CONNECTION_UNCLAIMED_EVENT_TYPE, { connection, externalId, projectId, slug });

describe("foldConnectionDirectory", () => {
  test("a matching unclaim clears a live claim", () => {
    const claims = foldConnectionDirectory([
      claim("slack", "T1", "prj_1", "acme"),
      unclaim("slack", "T1", "prj_1", "acme"),
    ]);
    expect(claims.size).toBe(0);
  });

  test("a stale connection's unclaim cannot tear down the live claim under a new name", () => {
    // Team T1 connected as "acme", disconnected, reconnected as "newco".
    // Disconnecting the leftover "acme" row must not unroute "newco".
    const claims = foldConnectionDirectory([
      claim("slack", "T1", "prj_1", "acme"),
      claim("slack", "T1", "prj_1", "newco"),
      unclaim("slack", "T1", "prj_1", "acme"),
    ]);
    expect(claims.get("slack T1")).toEqual({ connection: "newco", projectId: "prj_1" });
  });

  test("another project's unclaim never clears a claim; claims without a connection are ignored", () => {
    const claims = foldConnectionDirectory([
      event(CONNECTION_CLAIMED_EVENT_TYPE, { externalId: "T0", projectId: "prj_1", slug: "slack" }),
      claim("slack", "T1", "prj_1", "acme"),
      unclaim("slack", "T1", "prj_2", "acme"),
    ]);
    expect(claims.has("slack T0")).toBe(false);
    expect(claims.get("slack T1")).toEqual({ connection: "acme", projectId: "prj_1" });
  });

  test("another project's claim cannot replace a live owner", () => {
    const claims = foldConnectionDirectory([
      claim("github", "123", "prj_1", "install-123"),
      claim("github", "123", "prj_2", "stolen-install-123"),
    ]);
    expect(claims.get("github 123")).toEqual({
      connection: "install-123",
      projectId: "prj_1",
    });
  });

  test("the same external id under different slugs does not collide", () => {
    // A Slack team id and a GitHub installation id could be equal as strings;
    // the slug is part of the key so they route independently (D4).
    const claims = foldConnectionDirectory([
      claim("slack", "123", "prj_1", "acme-slack"),
      claim("github", "123", "prj_2", "acme-gh"),
    ]);
    expect(claims.get("slack 123")).toEqual({ connection: "acme-slack", projectId: "prj_1" });
    expect(claims.get("github 123")).toEqual({ connection: "acme-gh", projectId: "prj_2" });
  });
});
