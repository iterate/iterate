import { oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@jonasland5/shared";
import { z } from "zod/v4";
import packageJson from "../package.json" with { type: "json" };

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

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "Orders service health metadata",
  sqlSummary: "Execute SQL against orders-service sqlite database",
});

export const ordersContract = oc.router({
  ...serviceSubRouter,
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

const nonEmptyStringWithTrimDefault = (defaultValue: string) =>
  z
    .preprocess((value) => {
      if (typeof value !== "string") return value;
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    }, z.string().min(1).optional())
    .default(defaultValue);

export const ordersServiceEnvSchema = z.object({
  ORDERS_SERVICE_PORT: z.coerce.number().int().min(1).max(65535).default(19020),
  ORDERS_DB_PATH: nonEmptyStringWithTrimDefault("/var/lib/jonasland5/orders-service.sqlite"),
  EVENTS_SERVICE_BASE_URL: nonEmptyStringWithTrimDefault("http://127.0.0.1:19010/orpc"),
});

export type OrdersServiceEnv = z.infer<typeof ordersServiceEnvSchema>;

export const ordersServiceManifest = {
  name: packageJson.name,
  slug: "orders-service",
  version: packageJson.version ?? "0.0.0",
  port: 19020,
  orpcContract: ordersContract,
  envVars: ordersServiceEnvSchema,
} as const;
