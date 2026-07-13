import { beforeEach, describe, expect, test, vi } from "vitest";
import type { StreamEvent } from "../streams/schemas.ts";
import {
  appendConnectionDirectoryEvents,
  foldConnectionClaim,
  latestStreamEvent,
} from "./integration-streams.ts";
import {
  CONNECTION_CLAIMED_EVENT_TYPE,
  CONNECTION_UNCLAIMED_EVENT_TYPE,
  integrationDirectoryStreamPath,
} from "./utils.ts";

const { getByName } = vi.hoisted(() => ({ getByName: vi.fn() }));
vi.mock("../../env.ts", () => ({ itxEnv: { STREAM: { getByName } } }));

let offset = 0;
function event(type: string, payload: Record<string, unknown>): StreamEvent {
  offset += 1;
  return { createdAt: new Date().toISOString(), offset, payload, type } as StreamEvent;
}

const claim = (slug: string, externalId: string, projectId: string, connection: string) =>
  event(CONNECTION_CLAIMED_EVENT_TYPE, { connection, externalId, projectId, slug });
const unclaim = (slug: string, externalId: string, projectId: string, connection: string) =>
  event(CONNECTION_UNCLAIMED_EVENT_TYPE, { connection, externalId, projectId, slug });

beforeEach(() => {
  offset = 0;
  getByName.mockReset();
});

describe("latestStreamEvent", () => {
  test("returns an accepted newest row in one descending read", async () => {
    const newest = event("selected", { accepted: true });
    const getEvents = vi.fn().mockResolvedValue([newest]);
    getByName.mockReturnValue({ getEvents });

    await expect(
      latestStreamEvent(null, "/latest", ["selected"], (candidate) =>
        Boolean((candidate.payload as { accepted?: boolean }).accepted),
      ),
    ).resolves.toBe(newest);
    expect(getEvents).toHaveBeenCalledExactlyOnceWith({
      eventTypes: ["selected"],
      limit: 1,
      order: "desc",
    });
  });

  test("pages backward only after rejecting the newest row", async () => {
    const accepted = event("selected", { accepted: true });
    const rejectedPage = Array.from({ length: 500 }, () =>
      event("selected", { accepted: false }),
    ).reverse();
    const newest = event("selected", { accepted: false });
    const getEvents = vi
      .fn()
      .mockResolvedValueOnce([newest])
      .mockResolvedValueOnce(rejectedPage)
      .mockResolvedValueOnce([accepted]);
    getByName.mockReturnValue({ getEvents });

    await expect(
      latestStreamEvent(null, "/latest", ["selected"], (candidate) =>
        Boolean((candidate.payload as { accepted?: boolean }).accepted),
      ),
    ).resolves.toBe(accepted);
    expect(getEvents).toHaveBeenNthCalledWith(2, {
      beforeOffset: newest.offset,
      eventTypes: ["selected"],
      limit: 500,
      order: "desc",
    });
    expect(getEvents).toHaveBeenNthCalledWith(3, {
      beforeOffset: rejectedPage.at(-1)!.offset,
      eventTypes: ["selected"],
      limit: 500,
      order: "desc",
    });
  });
});

describe("foldConnectionClaim", () => {
  test("a matching unclaim clears a live claim", () => {
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

  test("another project's claim cannot replace a live owner", () => {
    expect(
      foldConnectionClaim(
        [
          claim("github", "123", "prj_1", "install-123"),
          claim("github", "123", "prj_2", "stolen-install-123"),
        ],
        { externalId: "123", slug: "github" },
      ),
    ).toEqual({ connection: "install-123", projectId: "prj_1" });
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
