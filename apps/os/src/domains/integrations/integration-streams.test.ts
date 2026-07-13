import { describe, expect, test } from "vitest";
import type { StreamEvent } from "../streams/schemas.ts";
import { appendConnectionDirectoryEvents, foldConnectionClaim } from "./integration-streams.ts";
import {
  CONNECTION_CLAIMED_EVENT_TYPE,
  CONNECTION_UNCLAIMED_EVENT_TYPE,
  integrationDirectoryStreamPath,
} from "./utils.ts";

let offset = 0;
function event(type: string, payload: Record<string, unknown>): StreamEvent {
  offset += 1;
  return { createdAt: new Date().toISOString(), offset, payload, type } as StreamEvent;
}

const claim = (slug: string, externalId: string, projectId: string, connection: string) =>
  event(CONNECTION_CLAIMED_EVENT_TYPE, { connection, externalId, projectId, slug });
const unclaim = (slug: string, externalId: string, projectId: string, connection: string) =>
  event(CONNECTION_UNCLAIMED_EVENT_TYPE, { connection, externalId, projectId, slug });

describe("foldConnectionClaim", () => {
  test("latest claim wins; a matching unclaim clears it", () => {
    expect(
      foldConnectionClaim(
        [claim("slack", "T1", "prj_1", "acme"), unclaim("slack", "T1", "prj_1", "acme")],
        { externalId: "T1", slug: "slack" },
      ),
    ).toBeNull();
  });

  test("a stale connection's unclaim cannot tear down the live claim under a new name", () => {
    // Team T1 connected as "acme", disconnected, reconnected as "newco".
    // Disconnecting the leftover "acme" row must not unroute "newco".
    expect(
      foldConnectionClaim(
        [
          claim("slack", "T1", "prj_1", "acme"),
          claim("slack", "T1", "prj_1", "newco"),
          unclaim("slack", "T1", "prj_1", "acme"),
        ],
        { externalId: "T1", slug: "slack" },
      ),
    ).toEqual({ connection: "newco", projectId: "prj_1" });
  });

  test("another project's unclaim never clears a claim; claims without a connection are ignored", () => {
    expect(
      foldConnectionClaim(
        [
          event(CONNECTION_CLAIMED_EVENT_TYPE, {
            externalId: "T0",
            projectId: "prj_1",
            slug: "slack",
          }),
          claim("slack", "T1", "prj_1", "acme"),
          unclaim("slack", "T1", "prj_2", "acme"),
        ],
        { externalId: "T1", slug: "slack" },
      ),
    ).toEqual({ connection: "acme", projectId: "prj_1" });
  });

  test("different keys sharing a bucket still fold independently", () => {
    expect(integrationDirectoryStreamPath("github", "2")).toBe(
      integrationDirectoryStreamPath("slack", "21"),
    );
    const events = [
      claim("slack", "21", "prj_1", "acme-slack"),
      claim("github", "2", "prj_2", "acme-gh"),
    ];
    expect(foldConnectionClaim(events, { externalId: "21", slug: "slack" })).toEqual({
      connection: "acme-slack",
      projectId: "prj_1",
    });
    expect(foldConnectionClaim(events, { externalId: "2", slug: "github" })).toEqual({
      connection: "acme-gh",
      projectId: "prj_2",
    });
  });

  test("provider external ids map deterministically across bounded directory buckets", () => {
    expect(integrationDirectoryStreamPath("slack", "T/1")).toBe("/integrations/_directory/0f");
    expect(integrationDirectoryStreamPath("slack", "T/1")).toBe(
      integrationDirectoryStreamPath("slack", "T/1"),
    );
  });

  test("one atomic directory append cannot span external-account owners", async () => {
    await expect(
      appendConnectionDirectoryEvents([
        {
          claimed: false,
          connection: "old",
          externalId: "T1",
          projectId: "prj_1",
          slug: "slack",
        },
        {
          claimed: true,
          connection: "new",
          externalId: "T2",
          projectId: "prj_2",
          slug: "slack",
        },
      ]),
    ).rejects.toThrow("cannot span integration external ids");
  });
});
