import { z } from "zod";
import {
  GenericEvent as GenericEventBase,
  GenericEventInput as GenericEventInputBase,
} from "./event-base-types.ts";
import { JsonataExpression } from "./jsonata-expression.ts";

export const HTML_RENDERER_CONFIGURED_TYPE =
  "https://events.iterate.com/events/stream/html-renderer-configured";

export const HtmlRendererConfiguredEventInput = GenericEventInputBase.extend({
  type: z.literal(HTML_RENDERER_CONFIGURED_TYPE),
  payload: z.strictObject({
    slug: z.string().trim().min(1),
    matcher: JsonataExpression,
    template: z.string().trim().min(1),
  }),
});
export const HtmlRendererConfiguredEvent = GenericEventBase.extend(
  HtmlRendererConfiguredEventInput.pick({ type: true, payload: true }).shape,
);
export type HtmlRendererConfiguredEventInput = z.infer<typeof HtmlRendererConfiguredEventInput>;
export type HtmlRendererConfiguredEvent = z.infer<typeof HtmlRendererConfiguredEvent>;
