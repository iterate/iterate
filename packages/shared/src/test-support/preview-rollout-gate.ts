/**
 * Absolute wall-clock boundary after which preview tests may create new
 * project-backed Durable Objects. Preview CI sets this from the successful OS
 * deploy timestamp; local development leaves it unset and waits zero time.
 */
export const PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV = "PREVIEW_APP_ROLLOUT_READY_AT_MS";

type PreviewRolloutGateEnvironment = Readonly<Record<string, string | undefined>>;

export function resolvePreviewRolloutWaitMs(input: {
  environment: PreviewRolloutGateEnvironment;
  nowMs?: number;
}): number {
  const rawReadyAtMs = input.environment[PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV]?.trim();
  if (!rawReadyAtMs) return 0;

  if (!/^\d+$/.test(rawReadyAtMs)) {
    throw new Error(`${PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV} must be an epoch-millisecond integer.`);
  }

  const readyAtMs = Number(rawReadyAtMs);
  if (!Number.isSafeInteger(readyAtMs)) {
    throw new Error(
      `${PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV} must be a safe epoch-millisecond integer.`,
    );
  }

  return Math.max(0, readyAtMs - (input.nowMs ?? Date.now()));
}

/**
 * Wait only at the operation that first creates project-backed Durable
 * Objects. Browser startup, authentication, and unrelated tests remain free to
 * overlap Cloudflare's global code propagation window.
 */
export async function waitForPreviewRolloutBeforeProjectCreation(input?: {
  beforeWait?: (waitMs: number) => void | Promise<void>;
  environment?: PreviewRolloutGateEnvironment;
  log?: (message: string) => void;
  nowMs?: number;
  sleep?: (waitMs: number) => Promise<void>;
}): Promise<void> {
  const environment = input?.environment || process.env;
  const waitMs = resolvePreviewRolloutWaitMs({ environment, nowMs: input?.nowMs });
  if (waitMs === 0) return;

  const readyAtMs = Number(environment[PREVIEW_APP_ROLLOUT_READY_AT_MS_ENV]);
  await input?.beforeWait?.(waitMs);
  (input?.log || console.log)(
    `[preview-rollout] project creation waits ${waitMs}ms until ${new Date(readyAtMs).toISOString()}`,
  );
  await (
    input?.sleep || ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)))
  )(waitMs);
}
