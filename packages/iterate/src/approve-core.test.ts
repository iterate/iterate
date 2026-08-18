import { describe, expect, test } from "vitest";
import type { RpcStub } from "@iterate-com/capnweb";
import type { Stream, StreamEvent } from "./itx-api.generated.ts";
import {
  awaitSettlement,
  decide,
  EVENT,
  reconcileBacklog,
  safeHost,
  summarizeRequests,
} from "./approve-core.ts";

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

test("decide keys the submitted decision, so a corrected retry does not collide", async () => {
  const appended: any[] = [];
  const stream: any = {
    append: async (event: any) => {
      appended.push(event);
      return [];
    },
  };
  const request: any = {
    stream,
    projectId: "prj_test",
    offset: 41,
    payload: {
      requests: [],
      ruleKey: "needs-human",
      ruleDescription: "needs a human",
      streamContext: { kind: "client-session", principal: "admin", admin: true },
      expiresAt: "2026-08-10T15:00:00.000Z",
    },
    verdicts: [],
  };

  // A stale client can submit an unsigned decision after the project has
  // enrolled a key. The door ignores it, then the client reloads the key and
  // submits the corrected signed decision for the same request offset.
  await decide({ ...request, key: null });
  await decide({
    ...request,
    key: {
      kind: "secure-enclave",
      keyId: "approval-key-1",
      publicKey: "public-key",
      label: "Test key",
      keyBlob: "key-blob",
    },
    verdicts: ["approve"],
    signature: "correct-signature",
  });
  await decide({
    ...request,
    key: {
      kind: "secure-enclave",
      keyId: "approval-key-1",
      publicKey: "public-key",
      label: "Test key",
      keyBlob: "key-blob",
    },
    verdicts: ["approve"],
    signature: "correct-signature",
  });

  expect(appended[0]).toMatchObject({
    type: EVENT.decided,
    payload: { approvalRequestEventOffset: 41, decidedBy: "human" },
  });
  expect(appended[1]).toMatchObject({
    type: EVENT.decided,
    payload: {
      approvalRequestEventOffset: 41,
      decidedBy: "human",
      keyId: "approval-key-1",
      signature: "correct-signature",
    },
  });
  expect(appended[0].idempotencyKey).not.toBe(appended[1].idempotencyKey);
  expect(appended[1].idempotencyKey).toBe(appended[2].idempotencyKey);
});

test("safeHost preserves the port that identifies a destination", () => {
  expect(safeHost("http://localhost:8080/refund")).toBe("localhost:8080");
});

test("summarizeRequests names a batch of one plainly and a burst by host, busiest first", () => {
  const gmail = { method: "POST", url: "https://gmail.googleapis.com/send" };
  const stripe = { method: "POST", url: "https://api.stripe.com/v1/transfers" };
  expect(summarizeRequests([stripe] as never)).toBe("POST api.stripe.com");
  expect(summarizeRequests([gmail, stripe, gmail] as never)).toBe(
    "3 requests (2x gmail.googleapis.com, 1x api.stripe.com)",
  );
});

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

describe("awaitSettlement — every approved index must settle", () => {
  test("released with per-index outcomes once every approved index settles", async () => {
    await expect(
      awaitSettlement(
        fakeStream([
          settled(11, { index: 0, status: 200 }),
          settled(12, { index: 1, status: 204 }),
        ]),
        REQUEST_OFFSET,
        ["approve", "approve"],
        WINDOW_MS,
      ),
    ).resolves.toEqual({
      kind: "released",
      outcomes: [
        { index: 0, status: 200, error: null },
        { index: 1, status: 204, error: null },
      ],
    });
  });

  test("a delivery failure rides its index's outcome", async () => {
    await expect(
      awaitSettlement(
        fakeStream([settled(11, { index: 0, error: "boom" })]),
        REQUEST_OFFSET,
        ["approve"],
        WINDOW_MS,
      ),
    ).resolves.toEqual({
      kind: "released",
      outcomes: [{ index: 0, status: null, error: "boom" }],
    });
  });

  test("mixed verdicts wait only for the approved indexes", async () => {
    await expect(
      awaitSettlement(
        fakeStream([settled(11, { index: 1, status: 200 })]),
        REQUEST_OFFSET,
        ["reject", "approve"],
        WINDOW_MS,
      ),
    ).resolves.toEqual({
      kind: "released",
      outcomes: [{ index: 1, status: 200, error: null }],
    });
  });

  test("an all-reject decision is terminal on the spot — nothing settles", async () => {
    await expect(
      awaitSettlement(fakeStream([]), REQUEST_OFFSET, ["reject", "reject"], WINDOW_MS),
    ).resolves.toEqual({ kind: "rejected", decidedBy: "human" });
  });

  test("the door's expiry decision mid-watch reports rejected/expiry", async () => {
    await expect(
      awaitSettlement(
        fakeStream([event(EVENT.decided, 11, { verdicts: ["reject"], decidedBy: "expiry" })]),
        REQUEST_OFFSET,
        ["approve"],
        WINDOW_MS,
      ),
    ).resolves.toEqual({ kind: "rejected", decidedBy: "expiry" });
  });

  test("unsettled when an approved index never settles in the window", async () => {
    await expect(
      awaitSettlement(
        fakeStream([settled(11, { index: 0, status: 200 })]),
        REQUEST_OFFSET,
        ["approve", "approve"],
        WINDOW_MS,
      ),
    ).resolves.toEqual({ kind: "unsettled" });
  });
});

describe("reconcileBacklog — the door honors the FIRST decision", () => {
  const req = (offset: number, count = 1, expiresInMs = 600_000): StreamEvent =>
    ({
      type: EVENT.requested,
      offset,
      payload: {
        requests: Array.from({ length: count }, () => ({
          method: "POST",
          url: "https://api.stripe.com/v1/transfers",
          secretPaths: [],
          body: null,
        })),
        ruleKey: "r",
        expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    }) as unknown as StreamEvent;
  const decidedOf = (offset: number, ref: number, verdicts: string[]): StreamEvent =>
    ({
      type: EVENT.decided,
      offset,
      payload: { approvalRequestEventOffset: ref, verdicts, decidedBy: "human" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }) as unknown as StreamEvent;
  const settledOf = (offset: number, ref: number, index: number): StreamEvent =>
    ({
      type: EVENT.settled,
      offset,
      payload: { approvalRequestEventOffset: ref, index, status: 200 },
      createdAt: "2026-01-01T00:00:00.000Z",
    }) as unknown as StreamEvent;

  const openShape = async (log: StreamEvent[]) =>
    (await reconcileBacklog(fakeStream(log))).open.map((batch) => ({
      offset: batch.offset,
      submitted: batch.submitted,
    }));

  test("a bare requested batch is open, not submitted", async () => {
    expect(await openShape([req(10)])).toEqual([{ offset: 10, submitted: false }]);
  });

  test("a decision whose approvals have not all settled is open AND submitted", async () => {
    expect(
      await openShape([
        req(10, 2),
        decidedOf(11, 10, ["approve", "approve"]),
        settledOf(12, 10, 0),
      ]),
    ).toEqual([{ offset: 10, submitted: true }]);
  });

  test("a fully settled decision is terminal — excluded", async () => {
    expect(
      await openShape([
        req(10, 2),
        decidedOf(11, 10, ["approve", "approve"]),
        settledOf(12, 10, 0),
        settledOf(13, 10, 1),
      ]),
    ).toEqual([]);
  });

  test("mixed verdicts settle on the approved indexes only", async () => {
    expect(
      await openShape([req(10, 2), decidedOf(11, 10, ["reject", "approve"]), settledOf(12, 10, 1)]),
    ).toEqual([]);
  });

  test("an all-reject decision is terminal — excluded", async () => {
    expect(await openShape([req(10), decidedOf(11, 10, ["reject"])])).toEqual([]);
  });

  test("only the FIRST decision counts; a later contradiction is dead weight", async () => {
    expect(
      await openShape([req(10), decidedOf(11, 10, ["reject"]), decidedOf(12, 10, ["approve"])]),
    ).toEqual([]);
  });

  test("a length-mismatched decision is ignored like the door ignores it — the batch stays open", async () => {
    expect(await openShape([req(10, 3), decidedOf(11, 10, ["reject"])])).toEqual([
      { offset: 10, submitted: false },
    ]);
    expect(
      await openShape([
        req(10, 3),
        decidedOf(11, 10, ["reject"]),
        decidedOf(12, 10, ["reject", "reject", "reject"]),
      ]),
    ).toEqual([]);
  });

  test("expired undecided batches are excluded; cursor is the highest offset seen", async () => {
    const { open, cursor } = await reconcileBacklog(
      fakeStream([req(10, 1, -1000), req(20), decidedOf(21, 20, ["approve"])]),
    );
    expect(open.map((batch) => ({ offset: batch.offset, verdicts: batch.verdicts }))).toEqual([
      { offset: 20, verdicts: ["approve"] },
    ]);
    expect(cursor).toBe(21);
  });
});
