import { oc } from "@orpc/contract";
import { z } from "zod/v4";

export const orderSchema = z.object({
  id: z.string(),
  sku: z.string().min(1),
  quantity: z.number().int().min(1),
  status: z.literal("accepted"),
  eventId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const createOrderInputSchema = z.object({
  sku: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(100),
});

export const listOrdersInputSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
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

    list: oc
      .route({
        method: "GET",
        path: "/orders",
        summary: "List recent orders",
        tags: ["orders"],
      })
      .input(listOrdersInputSchema)
      .output(
        z.object({
          orders: z.array(orderSchema),
          total: z.number().int().nonnegative(),
        }),
      ),

    find: oc
      .route({
        method: "GET",
        path: "/orders/{id}",
        summary: "Get order by id",
        tags: ["orders"],
      })
      .input(
        z.object({
          id: z.string(),
        }),
      )
      .output(orderSchema),

    update: oc
      .route({
        method: "PATCH",
        path: "/orders/{id}",
        summary: "Update an order by id",
        tags: ["orders"],
      })
      .input(
        z
          .object({
            id: z.string(),
            sku: z.string().min(1).optional(),
            quantity: z.coerce.number().int().min(1).max(100).optional(),
          })
          .refine((input) => input.sku !== undefined || input.quantity !== undefined, {
            message: "At least one field must be provided",
          }),
      )
      .output(orderSchema),

    remove: oc
      .route({
        method: "DELETE",
        path: "/orders/{id}",
        summary: "Delete an order by id",
        tags: ["orders"],
      })
      .input(
        z.object({
          id: z.string(),
        }),
      )
      .output(
        z.object({
          ok: z.literal(true),
          id: z.string(),
          deleted: z.boolean(),
        }),
      ),

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
