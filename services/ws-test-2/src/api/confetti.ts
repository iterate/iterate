import { z } from "zod";

const confettiMessageSchema = z.object({
  type: z.literal("launch"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export function createConfettiSocketHandlers() {
  let interval: ReturnType<typeof setInterval> | null = null;

  return {
    onOpen(_event: unknown, ws: { send: (value: string) => void }) {
      interval = setInterval(() => {
        ws.send(
          JSON.stringify({
            type: "boom",
            x: Math.random(),
            y: Math.random() * 0.6 + 0.1,
          }),
        );
      }, 1300);
    },
    onMessage(event: { data: unknown }, ws: { send: (value: string) => void }) {
      try {
        const message = confettiMessageSchema.parse(JSON.parse(String(event.data)));
        ws.send(
          JSON.stringify({
            type: "boom",
            x: message.x,
            y: message.y,
          }),
        );
      } catch {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Invalid confetti payload",
          }),
        );
      }
    },
    onClose() {
      if (interval) clearInterval(interval);
    },
    onError() {
      if (interval) clearInterval(interval);
    },
  };
}
