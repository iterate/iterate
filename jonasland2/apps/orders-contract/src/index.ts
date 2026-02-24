import { oc } from "@orpc/contract";
import { z } from "zod/v4";

export const orderSchema = z.object({
  id: z.string(),
  sku: z.string().min(1),
  quantity: z.number().int().min(1),
  status: z.literal("accepted"),
  eventId: z.string(),
  createdAt: z.string(),
});

export const createOrderInputSchema = z.object({
  sku: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(100),
});

export const ordersContract = oc.router({
  orders: {
    place: oc
      .route({
        method: "POST",
        path: "/orders",
        summary: "Place an order and emit an event",
        tags: ["orders"],
      })
      .input(createOrderInputSchema)
      .output(orderSchema),

    ping: oc
      .route({
        method: "GET",
        path: "/orders/ping",
        summary: "Simple health style ping",
        tags: ["orders"],
      })
      .input(z.object({}).optional().default({}))
      .output(
        z.object({
          ok: z.literal(true),
          service: z.string(),
        }),
      ),
  },
});
