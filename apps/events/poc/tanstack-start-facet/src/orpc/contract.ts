import { oc } from "@orpc/contract";
import { z } from "zod";

export const Thing = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

export const thingsContract = oc.router({
  ping: oc
    .route({ method: "GET", path: "/ping", description: "Health check", tags: ["debug"] })
    .output(z.object({ message: z.string(), serverTime: z.string(), doId: z.string() })),

  things: {
    list: oc
      .route({ method: "GET", path: "/things", description: "List all things", tags: ["things"] })
      .output(z.array(Thing)),

    create: oc
      .route({ method: "POST", path: "/things", description: "Create a thing", tags: ["things"] })
      .input(z.object({ name: z.string().min(1).max(200) }))
      .output(Thing),

    find: oc
      .route({
        method: "GET",
        path: "/things/{id}",
        description: "Get a thing by ID",
        tags: ["things"],
        inputStructure: "detailed",
      })
      .input(z.object({ id: z.string().min(1) }))
      .output(Thing),

    remove: oc
      .route({
        method: "DELETE",
        path: "/things/{id}",
        description: "Delete a thing",
        tags: ["things"],
        inputStructure: "detailed",
      })
      .input(z.object({ id: z.string().min(1) }))
      .output(z.object({ ok: z.literal(true), id: z.string(), deleted: z.boolean() })),
  },
});
