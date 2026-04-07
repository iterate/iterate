import { z } from "zod";

// `StreamPath` is the canonical parser for stream identifiers, including values
// that come from HTTP route params. It normalizes only the two cases we expect
// from routing:
// - add the leading slash when callers pass `foo/bar`
// - decode url-encoded slashes so `foo%2Fbar` becomes `/foo/bar`
//
// Everything else still has to already be a valid canonical stream path. We do
// not silently "fix" uppercase letters, extra punctuation, trailing slashes, or
// other malformed inputs because that would hide real misunderstandings.
// https://orpc.dev/docs/openapi/routing
// https://github.com/colinhacks/zod/blob/main/packages/docs-v3/README.md#preprocess
export const StreamPath = z.preprocess(
  (value) => {
    if (typeof value !== "string") {
      return value;
    }

    try {
      const decoded = decodeURIComponent(value);
      return decoded.startsWith("/") ? decoded : `/${decoded}`;
    } catch {
      return value;
    }
  },
  z
    .string()
    .max(1023)
    .regex(/^\/(?:[a-z0-9_-]+(?:\/[a-z0-9_-]+)*)?$/),
);
export type StreamPath = z.infer<typeof StreamPath>;

export const Offset = z.coerce.number().int().positive();
export type Offset = z.infer<typeof Offset>;

// Keep public payload/state shapes JSON-only so Cloudflare Durable Object RPC
// can prove they are serializable. `Record<string, unknown>` made the generated
// stub methods collapse to `never`, while bare `z.json()` would also allow
// top-level arrays/scalars/null. We want "JSON object with JSON values". For
// background on the `never` failure mode, see
// https://github.com/cloudflare/workerd/issues/2003.
export const JSONObject = z.record(z.string(), z.json());
export type JSONObject = z.infer<typeof JSONObject>;

export const EventTypeSchema = z.string().trim().min(1).max(2048);

// Built-in event input schemas extend this strict envelope in `types.ts`, so
// they inherit the same unknown-key rejection without repeating
// `z.strictObject(...)` at each call site.
export const GenericEventInput = z.strictObject({
  type: EventTypeSchema,
  payload: JSONObject.default({}),
  metadata: JSONObject.optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  offset: Offset.optional(),
});

export const GenericEvent = z.strictObject({
  streamPath: StreamPath,
  ...GenericEventInput.shape,
  offset: Offset,
  createdAt: z.iso.datetime({ offset: true }),
});
