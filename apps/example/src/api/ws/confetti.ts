import type { Hooks } from "crossws";
import { defineHooks } from "crossws";
import { z } from "zod";

const ConfettiMessage = z.object({
  type: z.literal("launch"),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});

export function createConfettiSocketHooks(delayMs: number): Partial<Hooks> {
  let interval: ReturnType<typeof setInterval> | null = null;
  const timeouts = new Set<ReturnType<typeof setTimeout>>();

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
    }, delayMs);
  }

  function sendLater(send: (value: string) => void, value: string) {
    const timeout = setTimeout(() => {
      timeouts.delete(timeout);
      send(value);
    }, delayMs);
    timeouts.add(timeout);
  }

  function clearTimers() {
    if (interval) clearInterval(interval);
    interval = null;
    for (const timeout of timeouts) {
      clearTimeout(timeout);
    }
    timeouts.clear();
  }

  return defineHooks({
    message(peer, message) {
      ensureInterval((value) => peer.send(value));
      try {
        const payload = ConfettiMessage.parse(JSON.parse(message.text()));
        sendLater(
          (value) => peer.send(value),
          JSON.stringify({ type: "boom", x: payload.x, y: payload.y }),
        );
      } catch {
        peer.send(JSON.stringify({ type: "error", message: "Invalid confetti payload" }));
      }
    },
    close() {
      clearTimers();
    },
    error() {
      clearTimers();
    },
  });
}
