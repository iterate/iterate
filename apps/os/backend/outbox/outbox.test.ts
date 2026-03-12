import { expectTypeOf, test } from "vitest";
import { appRouter } from "../orpc/root.ts";
import type { DBLike, FlattenProcedures, TimePeriod } from "./pgmq-lib.ts";
import { outboxClient } from "./client.ts";

test("oRPC procedure types are extracted correctly", () => {
  type F = FlattenProcedures<typeof appRouter>;
  // Verify the type utility can extract a known procedure path
  expectTypeOf<F>().toHaveProperty("admin.chargeUsage");
});

test("internal event types are type-safe", () => {
  const db = {} as DBLike;
  expectTypeOf(outboxClient.send).toBeCallableWith(db, {
    name: "testing:poke",
    payload: { dbtime: "2000-01-01T00:00:00.000Z", message: "hello" },
  });

  expectTypeOf(outboxClient)
    .map((client) =>
      client.send(db, {
        name: "testing:poke",
        payload: {
          dbtime: "2000-01-01T00:00:00.000Z",
          message: "hello",
        },
      }),
    )
    .resolves.toEqualTypeOf<{
      eventId: string | null;
      matchedConsumers: number;
      delays: TimePeriod[];
      duplicate: boolean;
    }>();

  expectTypeOf(outboxClient)
    .map((client) =>
      client.send(db, {
        name: "testing:poke",
        payload:
          // @ts-expect-error - typo in payload
          { dbtime: "2000-01-01T00:00:00.000Z", messageTYPO: "hello" },
      }),
    )
    .resolves.toEqualTypeOf<{
      eventId: string | null;
      matchedConsumers: number;
      delays: TimePeriod[];
      duplicate: boolean;
    }>();

  expectTypeOf(outboxClient.send).toBeCallableWith(db, {
    // @ts-expect-error - typo in event name
    name: "testing:pokeTYPO",
    payload: { dbtime: "2000-01-01T00:00:00.000Z", message: "hello" },
  });
});

test("machine:delete-requested event type", () => {
  const db = {} as DBLike;
  expectTypeOf(outboxClient.send).toBeCallableWith(db, {
    name: "machine:delete-requested",
    payload: {
      machineId: "mach_123",
      type: "daytona" as const,
      externalId: "ext_123",
      metadata: {},
    },
  });
});
