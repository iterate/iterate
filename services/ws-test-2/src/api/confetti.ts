import { z } from "zod";

const ConfettiMessage = z.object({
  type: z.literal("launch"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export function createConfettiSocketHandlers() {
  let interval: ReturnType<typeof setInterval> | null = null;

  function ensureInterval(ws: { send: (value: string) => void }) {
    if (interval) return;

    interval = setInterval(() => {
      ws.send(
        JSON.stringify({
          type: "boom",
          x: Math.random(),
          y: Math.random() * 0.6 + 0.1,
        }),
      );
    }, 1300);
  }

  return {
    onMessage(event: { data: unknown }, ws: { send: (value: string) => void }) {
      ensureInterval(ws);

      try {
        const message = ConfettiMessage.parse(JSON.parse(String(event.data)));
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
      interval = null;
    },
    onError() {
      if (interval) clearInterval(interval);
      interval = null;
    },
  };
}
