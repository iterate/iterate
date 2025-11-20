import { expectTypeOf, test } from "vitest";
import { appRouter } from "../../trpc/root.ts";
import type { FlattenProcedures } from "./events.ts";

test("event types", () => {
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
