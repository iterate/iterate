import type { Hooks } from "crossws";
import { defineHooks } from "crossws";
import { z } from "zod";

const ConfettiMessage = z.object({
  type: z.literal("launch"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export function createConfettiSocketHooks(): Partial<Hooks> {
  let interval: ReturnType<typeof setInterval> | null = null;

  function ensureInterval(send: (value: string) => void) {
    if (interval) return;

    interval = setInterval(() => {
      send(
        JSON.stringify({
          type: "boom",
          x: Math.random(),
          y: Math.random() * 0.6 + 0.1,
        }),
      );
    }, 1300);
  }

  return defineHooks({
    message(peer, message) {
      ensureInterval((value) => {
        peer.send(value);
      });

      try {
        const payload = ConfettiMessage.parse(JSON.parse(message.text()));
        peer.send(
          JSON.stringify({
            type: "boom",
            x: payload.x,
            y: payload.y,
          }),
        );
      } catch {
        peer.send(
          JSON.stringify({
            type: "error",
            message: "Invalid confetti payload",
          }),
        );
      }
    },
    close() {
      if (interval) clearInterval(interval);
      interval = null;
    },
    error() {
      if (interval) clearInterval(interval);
      interval = null;
    },
  });
}
