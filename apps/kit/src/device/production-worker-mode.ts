import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const ProductionKitVoiceHealth = z.strictObject({
  mode: z.enum(["grok", "tone"]),
  ok: z.literal(true),
  service: z.literal("iterate-kit-voice"),
});

export type ProductionKitVoiceHealth = z.infer<typeof ProductionKitVoiceHealth>;

export interface ProductionWorkerModeWaitOptions {
  expectedMode: ProductionKitVoiceHealth["mode"];
  fetch(request: Request): Promise<Response>;
  now?: () => number;
  pause?: (durationMs: number) => Promise<unknown>;
  retryDelayMs?: number;
  timeoutMs?: number;
}

/**
 * Fences a project-KV mode write at the dynamic worker location which will
 * accept the physical device's next `/pcm` connection.
 *
 * Iterate project KV is intentionally Workers KV: the writer can observe its
 * value immediately while another edge remains on the prior value for about
 * a minute. That is fine for ordinary knobs but unsafe for a deterministic
 * audio proof—starting early can accidentally record conversational Grok PCM,
 * and restoring early can leave the next real call on a tone provider. The
 * worker's own public health handler reads the same scoped configuration as
 * `/pcm`, so only that observation closes the propagation boundary.
 */
export async function waitForProductionWorkerMode(
  options: ProductionWorkerModeWaitOptions,
): Promise<ProductionKitVoiceHealth> {
  const now = options.now ?? Date.now;
  const pause = options.pause ?? delay;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 70_000;
  const deadline = now() + timeoutMs;
  let lastMode: ProductionKitVoiceHealth["mode"] | undefined;

  while (true) {
    const response = await options.fetch(new Request("https://iterate-kit-worker.invalid/health"));
    if (!response.ok) {
      throw new Error(`The production worker health request returned HTTP ${response.status}.`);
    }
    const parsed = ProductionKitVoiceHealth.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error(
        `The production worker returned a malformed health response: ${parsed.error.message}`,
      );
    }
    lastMode = parsed.data.mode;
    if (lastMode === options.expectedMode) return parsed.data;
    if (now() >= deadline) break;
    await pause(retryDelayMs);
  }

  throw new Error(
    `Timed out waiting for production worker mode ${options.expectedMode}; it still reported ${lastMode}.`,
  );
}
