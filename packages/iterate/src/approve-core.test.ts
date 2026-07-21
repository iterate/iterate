import { describe, expect, test } from "vitest";
import type { RpcStub } from "@iterate-com/capnweb";
import type { Stream, StreamEvent } from "./itx-api.generated.ts";
import { awaitSettlement, EVENT, reconcileBacklog } from "./approve-core.ts";

// A minimal stand-in for a project stream. `waitForEvent` replays from
// `afterOffset` in order and the earliest match wins — exactly the durable
// object's contract — sleeping then throwing the timeout error when nothing
// matches, so awaitSettlement's chunked re-arm loop terminates on its budget.
// `getEvents` returns every matching event after the offset, ascending, so
// reconcileBacklog's pager drains in one page then stops.
function fakeStream(log: StreamEvent[]): RpcStub<Stream> {
  return {
    waitForEvent: async (args: {
      afterOffset: number;
      eventTypes?: string[];
      predicate?: (event: StreamEvent) => boolean;
    }) => {
      const hit = log.find(
        (event) =>
          event.offset > args.afterOffset &&
          (args.eventTypes?.includes(event.type) ?? true) &&
          (args.predicate?.(event) ?? true),
      );
      if (hit === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("Timed out waiting for stream event");
      }
      return hit;
    },
    getEvents: async (args: { afterOffset: number; eventTypes?: string[] }) =>
      log
        .filter(
          (event) =>
            event.offset > args.afterOffset && (args.eventTypes?.includes(event.type) ?? true),
        )
        .sort((a, b) => a.offset - b.offset),
  } as unknown as RpcStub<Stream>;
}

const REQUEST_OFFSET = 10;
// A short settlement window so the no-match cases resolve fast under test.
const WINDOW_MS = 40;

function event(type: string, offset: number, payload: Record<string, unknown>): StreamEvent {
  return {
    type,
    offset,
    payload: { approvalRequestEventOffset: REQUEST_OFFSET, ...payload },
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as StreamEvent;
}

const settled = (offset: number, payload: Record<string, unknown>) =>
  event(EVENT.settled, offset, payload);
const rejected = (offset: number) => event(EVENT.rejected, offset, { reason: "human" });

describe("awaitSettlement — `settled` is authoritative over a stray reject", () => {
  test("released with the upstream status when the door settles", async () => {
    await expect(
      awaitSettlement(fakeStream([settled(11, { status: 200 })]), REQUEST_OFFSET, WINDOW_MS),
    ).resolves.toEqual({ kind: "released", status: 200 });
  });

  test("delivery-failed when the door settles with an error", async () => {
    await expect(
      awaitSettlement(fakeStream([settled(11, { error: "boom" })]), REQUEST_OFFSET, WINDOW_MS),
    ).resolves.toEqual({ kind: "delivery-failed", error: "boom" });
  });

  test("rejected only when no grant ever settled", async () => {
    await expect(
      awaitSettlement(fakeStream([rejected(11)]), REQUEST_OFFSET, WINDOW_MS),
    ).resolves.toEqual({ kind: "rejected", reason: "human" });
  });

  test("a reject that lands BEFORE a winning grant's settle still reports released", async () => {
    // A second approver's veto (offset 11) beat the door's settle (offset 12),
    // but the grant won — the re-scan finds the settled and released wins.
    await expect(
      awaitSettlement(
        fakeStream([rejected(11), settled(12, { status: 204 })]),
        REQUEST_OFFSET,
        WINDOW_MS,
      ),
    ).resolves.toEqual({ kind: "released", status: 204 });
  });

  test("a settle already committed before a stray reject reports released", async () => {
    await expect(
      awaitSettlement(
        fakeStream([settled(11, { status: 200 }), rejected(12)]),
        REQUEST_OFFSET,
        WINDOW_MS,
      ),
    ).resolves.toEqual({ kind: "released", status: 200 });
  });

  test("unsettled when nothing lands in the window", async () => {
    await expect(awaitSettlement(fakeStream([]), REQUEST_OFFSET, WINDOW_MS)).resolves.toEqual({
      kind: "unsettled",
    });
  });
});

describe("reconcileBacklog — the door's first resolution is authoritative", () => {
  const req = (offset: number, expiresInMs = 600_000): StreamEvent =>
    ({
      type: EVENT.requested,
      offset,
      payload: {
        method: "POST",
        url: "https://api.stripe.com/v1/transfers",
        secretPaths: [],
        ruleKey: "r",
        expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
        bodyPreview: null,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    }) as unknown as StreamEvent;
  const resolution = (type: string, offset: number, ref: number): StreamEvent =>
    ({
      type,
      offset,
      payload: { approvalRequestEventOffset: ref, status: 200, reason: "human" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }) as unknown as StreamEvent;
  const grantOf = (offset: number, ref: number) => resolution(EVENT.granted, offset, ref);
  const rejectOf = (offset: number, ref: number) => resolution(EVENT.rejected, offset, ref);

  const openShape = async (log: StreamEvent[]) =>
    (await reconcileBacklog(fakeStream(log))).open.map((o) => ({
      offset: o.offset,
      submitted: o.submitted,
    }));

  test("a bare requested is open, not submitted", async () => {
    expect(await openShape([req(10)])).toEqual([{ offset: 10, submitted: false }]);
  });

  test("a grant with no settle is open AND submitted (awaiting the door)", async () => {
    expect(await openShape([req(10), grantOf(11, 10)])).toEqual([{ offset: 10, submitted: true }]);
  });

  test("a settled request is terminal — excluded", async () => {
    expect(await openShape([req(10), grantOf(11, 10), resolution(EVENT.settled, 12, 10)])).toEqual(
      [],
    );
  });

  test("a reject with no competing grant is terminal — excluded", async () => {
    expect(await openShape([req(10), rejectOf(11, 10)])).toEqual([]);
  });

  test("grant THEN a stray reject (no settle) stays open+submitted — the release can still land", async () => {
    expect(await openShape([req(10), grantOf(11, 10), rejectOf(12, 10)])).toEqual([
      { offset: 10, submitted: true },
    ]);
  });

  test("reject THEN grant (the reject won at the door) is terminal — excluded", async () => {
    expect(await openShape([req(10), rejectOf(11, 10), grantOf(12, 10)])).toEqual([]);
  });

  test("expired requests are excluded; cursor is the highest offset seen", async () => {
    const { open, cursor } = await reconcileBacklog(
      fakeStream([req(10, -1000), req(20), grantOf(21, 20)]),
    );
    expect(open.map((o) => o.offset)).toEqual([20]);
    expect(cursor).toBe(21);
  });
});
