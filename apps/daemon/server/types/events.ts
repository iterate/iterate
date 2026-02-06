import { z } from "zod/v4";

export const PromptEvent = z.object({
  type: z.literal("prompt"),
  message: z.string(),
});

export const IterateEvent = z.discriminatedUnion("type", [PromptEvent]);

export type PromptEvent = z.infer<typeof PromptEvent>;
export type IterateEvent = z.infer<typeof IterateEvent>;

export function isPromptEvent(event: unknown): event is PromptEvent {
  return PromptEvent.safeParse(event).success;
}

export function isIterateEvent(event: unknown): event is IterateEvent {
  return IterateEvent.safeParse(event).success;
}

export function extractIterateEvents(payload: unknown): IterateEvent[] {
  const raw = Array.isArray(payload) ? payload : [payload];
  return raw.flatMap((event) => {
    const parsed = IterateEvent.safeParse(event);
    return parsed.success ? [parsed.data] : [];
  });
}
