import { describe, expect, test } from "vitest";
import type { RpcStub } from "capnweb";
import type { Stream, StreamEvent } from "./itx-api.generated.ts";
import { awaitSettlement, EVENT } from "./approve-core.ts";

// A minimal stand-in for a project stream: `waitForEvent` replays from
// `afterOffset` in order and the earliest match wins — exactly the durable
// object's contract — throwing the timeout error when nothing matches.
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
      if (hit === undefined) throw new Error("Timed out waiting for stream event");
      return hit;
    },
  } as unknown as RpcStub<Stream>;
}

const REQUEST_OFFSET = 10;

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
      awaitSettlement(fakeStream([settled(11, { status: 200 })]), REQUEST_OFFSET),
    ).resolves.toEqual({ kind: "released", status: 200 });
  });

  test("delivery-failed when the door settles with an error", async () => {
    await expect(
      awaitSettlement(fakeStream([settled(11, { error: "boom" })]), REQUEST_OFFSET),
    ).resolves.toEqual({ kind: "delivery-failed", error: "boom" });
  });

  test("rejected only when no grant ever settled", async () => {
    await expect(awaitSettlement(fakeStream([rejected(11)]), REQUEST_OFFSET)).resolves.toEqual({
      kind: "rejected",
      reason: "human",
    });
  });

  test("a reject that lands BEFORE a winning grant's settle still reports released", async () => {
    // A second approver's veto (offset 11) beat the door's settle (offset 12),
    // but the grant won — the grace re-scan finds the settled and released wins.
    await expect(
      awaitSettlement(fakeStream([rejected(11), settled(12, { status: 204 })]), REQUEST_OFFSET),
    ).resolves.toEqual({ kind: "released", status: 204 });
  });

  test("a settle already committed before a stray reject reports released", async () => {
    await expect(
      awaitSettlement(fakeStream([settled(11, { status: 200 }), rejected(12)]), REQUEST_OFFSET),
    ).resolves.toEqual({ kind: "released", status: 200 });
  });

  test("unsettled when nothing lands in the window", async () => {
    await expect(awaitSettlement(fakeStream([]), REQUEST_OFFSET)).resolves.toEqual({
      kind: "unsettled",
    });
  });
});
