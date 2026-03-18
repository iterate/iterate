import { oc } from "@orpc/contract";
import { createServiceSubRouterContract } from "@iterate-com/shared/jonasland/service-contract";
import { z } from "zod";

const serviceSubRouter = createServiceSubRouterContract({
  healthSummary: "Example service health metadata",
  sqlSummary: "Execute SQL against example database",
  debugSummary: "Example service runtime debug details",
});

export const exampleContract = oc.router({
  ...serviceSubRouter,
  ping: oc
    .route({ method: "GET", path: "/ping", summary: "Ping", tags: ["debug"] })
    .input(z.object({}).optional().default({}))
    .output(z.object({ message: z.string(), serverTime: z.string() })),
  pirateSecret: oc
    .route({
      method: "GET",
      path: "/pirate-secret",
      summary: "Reveal the configured pirate secret",
      tags: ["debug"],
    })
    .input(z.object({}).optional().default({}))
    .output(z.object({ secret: z.string() })),
  things: {
    create: oc
      .route({ method: "POST", path: "/things", summary: "Create a thing", tags: ["things"] })
      .input(z.object({ thing: z.string().min(1) }))
      .output(
        z.object({
          id: z.string(),
          thing: z.string(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      ),
    list: oc
      .route({ method: "GET", path: "/things", summary: "List things", tags: ["things"] })
      .input(
        z.object({
          limit: z.coerce.number().int().min(1).max(100).optional().default(20),
          offset: z.coerce.number().int().min(0).optional().default(0),
        }),
      )
      .output(
        z.object({
          things: z.array(
            z.object({
              id: z.string(),
              thing: z.string(),
              createdAt: z.string(),
              updatedAt: z.string(),
            }),
          ),
          total: z.number().int().nonnegative(),
        }),
      ),
    find: oc
      .route({ method: "GET", path: "/things/{id}", summary: "Get thing by id", tags: ["things"] })
      .input(z.object({ id: z.string() }))
      .output(
        z.object({
          id: z.string(),
          thing: z.string(),
          createdAt: z.string(),
          updatedAt: z.string(),
        }),
      ),
    remove: oc
      .route({ method: "DELETE", path: "/things/{id}", summary: "Delete thing", tags: ["things"] })
      .input(z.object({ id: z.string() }))
      .output(z.object({ ok: z.literal(true), id: z.string(), deleted: z.boolean() })),
  },
});
