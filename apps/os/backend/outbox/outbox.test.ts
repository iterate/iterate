import { expectTypeOf, test } from "vitest";
import { appRouter } from "../trpc/root.ts";
import { getDb } from "../db/client.ts";
import type { DBLike, FlattenProcedures } from "./pgmq-lib.ts";
import { outboxClient } from "./client.ts";

test("trpc types", () => {
  type F = FlattenProcedures<typeof appRouter._def.procedures>;
  expectTypeOf<F>().toHaveProperty("admin.listUsers");
});

test("internal event types", () => {
  const db = {} as DBLike;
  expectTypeOf(outboxClient.send).toBeCallableWith(
    { transaction: db, parent: db },
    "testing:poke",
    { dbtime: "2000-01-01T00:00:00.000Z", message: "hello" },
  );

  expectTypeOf(outboxClient)
    .map((client) =>
      client.send({ transaction: db, parent: db }, "testing:poke", {
        dbtime: "2000-01-01T00:00:00.000Z",
        message: "hello",
      }),
    )
    .resolves.toEqualTypeOf<{ eventId: string; matchedConsumers: number }>();

  expectTypeOf(outboxClient)
    .map((client) =>
      client.send(
        { transaction: db, parent: db },
        "testing:poke",
        // @ts-expect-error - typo in payload
        { dbtime: "2000-01-01T00:00:00.000Z", messageTYPO: "hello" },
      ),
    )
    .resolves.toEqualTypeOf<{ eventId: string; matchedConsumers: number }>();

  expectTypeOf(outboxClient.send).toBeCallableWith(
    { transaction: db, parent: db },
    // @ts-expect-error - typo in event name
    "testing:pokeTYPO",
    { message: "hello" },
  );
});

test("sendTx", () => {
  const parent = {} as ReturnType<typeof getDb>;
  expectTypeOf(outboxClient)
    .map((client) => {
      return client.sendTx(parent, "testing:poke", async (tx) => {
        expectTypeOf(
          tx.query.outboxEvent.findFirst({ columns: { id: true } }),
        ).resolves.toEqualTypeOf<{ id: number } | undefined>();
        return { payload: { dbtime: "2000-01-01T00:00:00.000Z", message: "hello" } };
      });
    })
    .resolves.toEqualTypeOf<{ payload: { dbtime: string; message: string } }>();
});
