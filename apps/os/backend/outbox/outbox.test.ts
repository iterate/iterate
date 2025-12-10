import { expectTypeOf, test } from "vitest";
import { appRouter } from "../trpc/root.ts";
import { getDb } from "../db/client.ts";
import type { DBLike, FlattenProcedures } from "./pgmq-lib.ts";
import { outboxClient } from "./client.ts";

test("trpc types", () => {
  type F = FlattenProcedures<typeof appRouter._def.procedures>;
  expectTypeOf<F>()
    .toHaveProperty("admin.createStripeCustomer")
    .map((proc) => proc._def.$types).toEqualTypeOf<{
    input: {
      organizationId: string;
    };
    output: {
      success: boolean;
      stripeCustomerId: string;
    };
  }>;
});

test("internal event types", () => {
  const db = {} as DBLike;
  expectTypeOf(outboxClient.sendEvent).toBeCallableWith(
    { transaction: db, parent: db },
    "testing:poke",
    { dbtime: "2000-01-01T00:00:00.000Z", message: "hello" },
  );

  expectTypeOf(outboxClient.sendEvent).toBeCallableWith(
    { transaction: db, parent: db },
    "testing:poke",
    // @ts-expect-error - typo in payload
    { messageTYPO: "hello" },
  );
  expectTypeOf(outboxClient.sendEvent).toBeCallableWith(
    { transaction: db, parent: db },
    // @ts-expect-error - typo in event name
    "testing:pokeTYPO",
    { message: "hello" },
  );
});

test("createEvent", () => {
  expectTypeOf(outboxClient)
    .map((client) => {
      return client.createEvent(getDb(), "testing:poke", async (tx) => {
        // make sure tx is usable as a normal drizzle transaction helper
        expectTypeOf(
          tx.query.outboxEvent.findFirst({ columns: { id: true } }),
        ).resolves.toEqualTypeOf<{ id: number } | undefined>();
        return { dbtime: "2000-01-01T00:00:00.000Z", message: "hello" };
      });
    })
    .resolves.toEqualTypeOf<{ dbtime: string; message: string }>();
});
