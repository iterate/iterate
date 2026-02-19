import { expectTypeOf, test } from "vitest";
import { appRouter } from "../trpc/root.ts";
import type { DBLike, FlattenProcedures } from "./pgmq-lib.ts";
import { outboxClient } from "./client.ts";

test("trpc procedure types are extracted correctly", () => {
  type F = FlattenProcedures<typeof appRouter._def.procedures>;
  expectTypeOf<F>()
    .toHaveProperty("admin.chargeUsage")
    .map((proc) => proc._def.$types)
    .toEqualTypeOf<{
      input: {
        organizationId: string;
        units: number;
      };
      output: {
        success: boolean;
        units: number;
        costCents: number;
        meterEventId: string;
        stripeCustomerId: string;
      };
    }>();
});

test("internal event types are type-safe", () => {
  const db = {} as DBLike;
  expectTypeOf(outboxClient.send).toBeCallableWith(
    { transaction: db, parent: db },
    "testing:poke",
    { dbtime: "2000-01-01T00:00:00.000Z", message: "hello" },
  );

  type Seconds = `${number}s`; // outbox only supports seconds for now, test will need updating if we add other units

  expectTypeOf(outboxClient)
    .map((client) =>
      client.send({ transaction: db, parent: db }, "testing:poke", {
        dbtime: "2000-01-01T00:00:00.000Z",
        message: "hello",
      }),
    )
    .resolves.toEqualTypeOf<{ eventId: string; matchedConsumers: number; delays: Seconds[] }>();

  expectTypeOf(outboxClient)
    .map((client) =>
      client.send(
        { transaction: db, parent: db },
        "testing:poke",
        // @ts-expect-error - typo in payload
        { dbtime: "2000-01-01T00:00:00.000Z", messageTYPO: "hello" },
      ),
    )
    .resolves.toEqualTypeOf<{ eventId: string; matchedConsumers: number; delays: Seconds[] }>();

  expectTypeOf(outboxClient.send).toBeCallableWith(
    { transaction: db, parent: db },
    // @ts-expect-error - typo in event name
    "testing:pokeTYPO",
    { message: "hello" },
  );
});

test("machine:archive-requested event type", () => {
  const db = {} as DBLike;
  expectTypeOf(outboxClient.send).toBeCallableWith(
    { transaction: db, parent: db },
    "machine:archive-requested",
    {
      machineId: "mach_123",
      type: "daytona" as const,
      externalId: "ext_123",
      metadata: {},
    },
  );
});
