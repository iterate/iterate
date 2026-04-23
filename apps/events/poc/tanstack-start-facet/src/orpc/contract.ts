import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

export const Thing = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

export const RandomLogStreamRequest = z.object({
  count: z.number().int().min(1).max(500),
  minDelayMs: z.number().int().min(0).max(10_000),
  maxDelayMs: z.number().int().min(1).max(10_000),
});

export type RandomLogStreamRequest = z.infer<typeof RandomLogStreamRequest>;

export const appContract = oc.router({
  ping: oc
    .route({ method: "GET", path: "/ping", description: "Health check", tags: ["debug"] })
    .output(z.object({ message: z.string(), time: z.string() })),

  things: {
    list: oc
      .route({ method: "GET", path: "/things", description: "List all things", tags: ["things"] })
      .output(z.object({ items: z.array(Thing), total: z.number() })),

    create: oc
      .route({ method: "POST", path: "/things", description: "Create a thing", tags: ["things"] })
      .input(z.object({ name: z.string().min(1).max(200) }))
      .output(Thing),

    remove: oc
      .route({
        method: "POST",
        path: "/things/remove",
        description: "Delete a thing",
        tags: ["things"],
      })
      .input(z.object({ id: z.string().min(1) }))
      .output(z.object({ ok: z.literal(true), id: z.string(), deleted: z.boolean() })),
  },

  test: {
    randomLogStream: oc
      .route({
        method: "POST",
        path: "/test/random-log-stream",
        description: "Stream random log lines with variable delays (async iterator)",
        tags: ["streaming"],
      })
      .input(RandomLogStreamRequest)
      .output(eventIterator(z.string())),
  },
});
