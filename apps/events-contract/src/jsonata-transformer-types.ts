import { z } from "zod";
import {
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
} from "./event-base-types.ts";

export const JsonataTransformerConfiguredEventInput = GenericEventInputBase.extend({
  type: z.literal("https://events.iterate.com/events/stream/jsonata-transformer-configured"),
  payload: z.strictObject({
    slug: z.string().trim().min(1),
    matcher: z.string().trim().min(1),
    transform: z.string().trim().min(1),
  }),
});
export const JsonataTransformerConfiguredEvent = GenericEventBase.extend(
  JsonataTransformerConfiguredEventInput.pick({ type: true, payload: true }).shape,
);
export type JsonataTransformerConfiguredEventInput = z.infer<
  typeof JsonataTransformerConfiguredEventInput
>;
export type JsonataTransformerConfiguredEvent = z.infer<typeof JsonataTransformerConfiguredEvent>;

export const JsonataTransformerState = z.object({
  transformersBySlug: z.record(
    z.string(),
    z.object({
      matcher: z.string(),
      transform: z.string(),
    }),
  ),
});
export type JsonataTransformerState = z.infer<typeof JsonataTransformerState>;
