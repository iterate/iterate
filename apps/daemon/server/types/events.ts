import { z } from "zod/v4";

export const PromptEventSchema = z.object({
  type: z.literal("prompt"),
  message: z.string(),
});

export const IterateEventSchema = z.discriminatedUnion("type", [PromptEventSchema]);

export type PromptEvent = z.infer<typeof PromptEventSchema>;
export type IterateEvent = z.infer<typeof IterateEventSchema>;

export function isPromptEvent(event: unknown): event is PromptEvent {
  return PromptEventSchema.safeParse(event).success;
}

export function isIterateEvent(event: unknown): event is IterateEvent {
  return IterateEventSchema.safeParse(event).success;
}

export function extractIterateEvents(payload: unknown): IterateEvent[] {
  const raw = Array.isArray(payload) ? payload : [payload];
  return raw.flatMap((event) => {
    const parsed = IterateEventSchema.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
}
