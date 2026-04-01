import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

const streamPathPattern = /^\/(?:[a-z0-9_-]+(?:\/[a-z0-9_-]+)*)?$/;

export const EventType = z.string().trim().min(1).max(2048);
export type EventType = z.infer<typeof EventType>;

export const StreamPath = z.preprocess((value: unknown) => {
  if (typeof value !== "string") {
    return value;
  }

  try {
    const decoded = decodeURIComponent(value);
    return decoded.startsWith("/") ? decoded : `/${decoded}`;
  } catch {
    return value;
  }
}, z.string().max(1023).regex(streamPathPattern));
export type StreamPath = z.infer<typeof StreamPath>;

export const Offset = z.string().trim().min(1);
export type Offset = z.infer<typeof Offset>;

export const JSONObject = z.record(z.string(), z.json());
export type JSONObject = z.infer<typeof JSONObject>;

export const EventInput = z.object({
  path: StreamPath,
  type: EventType,
  payload: JSONObject,
  metadata: JSONObject.optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
});
export type EventInput = z.infer<typeof EventInput>;

export const Event = EventInput.extend({
  offset: Offset,
  createdAt: z.iso.datetime({ offset: true }),
});
export type Event = z.infer<typeof Event>;

const AppendInput = z.intersection(
  z.object({
    path: StreamPath,
  }),
  z.union([
    EventInput,
    z.object({
      events: z.array(EventInput).min(1),
    }),
  ]),
);

export const eventsContract = oc.router({
  append: oc
    .route({
      operationId: "appendStreamEvents",
      method: "POST",
      path: "/streams/{+path}",
      tags: ["Streams"],
    })
    .input(AppendInput)
    .output(
      z.object({
        created: z.boolean(),
        events: z.array(Event),
      }),
    ),
  stream: oc
    .route({
      operationId: "streamEvents",
      method: "GET",
      path: "/streams/{+path}",
      tags: ["Streams"],
    })
    .input(
      z.object({
        path: StreamPath,
        offset: Offset.optional(),
        live: z.coerce.boolean().optional(),
      }),
    )
    .output(eventIterator(Event)),
});
