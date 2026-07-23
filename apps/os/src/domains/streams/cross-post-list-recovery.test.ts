import { DatabaseSync } from "node:sqlite";
import type { StreamEvent } from "iterate/processors";
import { describe, expect, it } from "vitest";
import { CoreProcessorContract, type CoreProcessorState } from "./core-processor-contract.ts";
import { StreamCoreProcessor } from "./core-processor.ts";
import {
  MAX_CROSS_POST_LIST_ATTEMPTS,
  CrossPostListRetryStore,
} from "./cross-post-list-retry-store.ts";

const PROJECT_ID = "prj_cross_post_list_recovery";
const SOURCE_PATH = "/sources/issues";
const RECEIVER_PATH = "/agents/reviewer";
const SUBSCRIPTION_KEY = "issues";
const SOURCE_STREAM_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_STREAM_CREATED_AT = "2026-07-22T09:59:00.000Z";

function wrapSqlStorage(db: DatabaseSync): SqlStorage {
  return {
    exec<T = unknown>(sql: string, ...bindings: (ArrayBuffer | null | number | string)[]) {
      const rows = db
        .prepare(sql)
        .all(
          ...bindings.map((binding) =>
            binding instanceof ArrayBuffer ? new Uint8Array(binding) : binding,
          ),
        )
        .map((row) => Object.fromEntries(Object.entries(row).map(fromNodeSqlValue)));
      return { toArray: () => rows as T[] };
    },
  } as SqlStorage;
}

function fromNodeSqlValue([key, value]: [string, unknown]) {
  if (value instanceof Uint8Array) {
    return [key, value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)];
  }
  return [key, value];
}

function committed(
  offset: number,
  type: string,
  payload: Record<string, unknown>,
  path = SOURCE_PATH,
): StreamEvent {
  return {
    type,
    payload,
    offset,
    path,
    createdAt: `2026-07-22T10:00:${String(offset).padStart(2, "0")}.000Z`,
  };
}

function reduce(
  processor: StreamCoreProcessor,
  state: CoreProcessorState,
  event: StreamEvent,
): CoreProcessorState {
  return processor.reduce({ state, event });
}

describe("cross-post list recovery", () => {
  it("exhausts the shared receiver-call budget, blocks, starts an explicit resend generation, and records its ack", () => {
    const sql = wrapSqlStorage(new DatabaseSync(":memory:"));
    const retries = new CrossPostListRetryStore(sql);
    const processor = new StreamCoreProcessor({ projectId: PROJECT_ID });
    let state = CoreProcessorContract.stateSchema.parse({
      projectId: PROJECT_ID,
      path: SOURCE_PATH,
    });

    state = reduce(
      processor,
      state,
      committed(2, "events.iterate.com/stream/subscription-configured", {
        subscriptionKey: SUBSCRIPTION_KEY,
        receiver: {
          action: "cross-post",
          receivingStreamPath: RECEIVER_PATH,
          delivery: {
            start: "beginning",
            onFailingEvent: "halt",
            includeEphemeral: false,
          },
        },
      }),
    );
    retries.ensure(RECEIVER_PATH, 2);

    for (let attempt = 1; attempt < MAX_CROSS_POST_LIST_ATTEMPTS; attempt += 1) {
      retries.fail(RECEIVER_PATH, {
        sourceOffset: 2,
        attempt,
        nextAttemptAt: attempt * 1_000,
        error: `receiver failure ${attempt}`,
      });
    }
    expect(retries.get(RECEIVER_PATH)).toMatchObject({
      sourceOffset: 2,
      attempt: MAX_CROSS_POST_LIST_ATTEMPTS - 1,
    });
    expect(state.crossPostListDeliveriesByReceivingStream[RECEIVER_PATH]).toEqual({
      sourceOffset: 2,
      status: "pending",
      subscriptionKeysRecordedByReceiver: [],
    });

    state = reduce(
      processor,
      state,
      committed(3, "events.iterate.com/stream/cross-post-list-delivery-blocked", {
        receivingStreamPath: RECEIVER_PATH,
        sourceOffset: 2,
        attempts: MAX_CROSS_POST_LIST_ATTEMPTS,
        error: `receiver failure ${MAX_CROSS_POST_LIST_ATTEMPTS}`,
      }),
    );
    const blocked = state.crossPostListDeliveriesByReceivingStream[RECEIVER_PATH];
    expect(blocked).toMatchObject({
      sourceOffset: 2,
      status: "blocked",
      attempts: MAX_CROSS_POST_LIST_ATTEMPTS,
    });
    if (blocked?.status !== "blocked") throw new Error("expected the list to be blocked");
    retries.delete(RECEIVER_PATH, 2);
    expect(retries.get(RECEIVER_PATH)).toBeUndefined();

    const resend = committed(4, "events.iterate.com/stream/cross-post-list-resend-requested", {
      receivingStreamPath: RECEIVER_PATH,
    });
    processor.validate({
      event: { type: resend.type, payload: resend.payload },
      state,
      authority: "public",
    });
    state = reduce(processor, state, resend);
    retries.ensure(RECEIVER_PATH, resend.offset);
    expect(state.crossPostListDeliveriesByReceivingStream[RECEIVER_PATH]).toEqual({
      sourceOffset: 4,
      status: "pending",
      subscriptionKeysRecordedByReceiver: [],
    });
    expect(retries.get(RECEIVER_PATH)).toMatchObject({
      sourceOffset: 4,
      attempt: 0,
      nextAttemptAt: null,
      lastError: null,
    });

    const receivingStreamEvent = committed(
      1,
      "events.iterate.com/stream/cross-post-list-recorded",
      {
        source: {
          projectId: PROJECT_ID,
          path: SOURCE_PATH,
          streamId: SOURCE_STREAM_ID,
          streamCreatedAt: SOURCE_STREAM_CREATED_AT,
        },
        sourceOffset: 4,
        subscriptionsByKey: {
          [SUBSCRIPTION_KEY]: {
            configuredAtSourceOffset: 2,
            configuration: {
              delivery: {
                start: "beginning",
                onFailingEvent: "halt",
                includeEphemeral: false,
              },
            },
          },
        },
      },
      RECEIVER_PATH,
    );
    state = reduce(
      processor,
      state,
      committed(5, "events.iterate.com/stream/cross-post-list-confirmed", {
        receivingStreamPath: RECEIVER_PATH,
        sourceOffset: 4,
        receivingStreamEvent,
      }),
    );
    retries.delete(RECEIVER_PATH, 4);

    expect(state.crossPostListDeliveriesByReceivingStream[RECEIVER_PATH]).toEqual({
      sourceOffset: 4,
      status: "confirmed",
      subscriptionKeysRecordedByReceiver: [SUBSCRIPTION_KEY],
    });
    expect(retries.get(RECEIVER_PATH)).toBeUndefined();
  });
});
