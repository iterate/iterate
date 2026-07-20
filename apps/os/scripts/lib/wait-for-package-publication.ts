const PKG_PR_NEW_PREFIX = "https://pkg.pr.new/";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const PROBE_TIMEOUT_MS = 10_000;

export async function waitForPkgPrNewPublication(
  packageSpec: string | undefined,
  options: {
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    log?: (message: string) => void;
    now?: () => number;
    pollIntervalMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  if (packageSpec === undefined || !packageSpec.startsWith(PKG_PR_NEW_PREFIX)) return;

  const fetchPackage = options.fetch ?? globalThis.fetch;
  const log = options.log ?? console.log;
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const sleep =
    options.sleep ??
    (async (milliseconds: number) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
    });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = now();
  let attempts = 0;
  let lastFailure = "not probed";

  while (true) {
    attempts += 1;
    const remainingBeforeProbe = Math.max(1, timeoutMs - (now() - startedAt));
    try {
      const response = await fetchPackage(packageSpec, {
        method: "HEAD",
        signal: AbortSignal.timeout(Math.min(PROBE_TIMEOUT_MS, remainingBeforeProbe)),
      });
      if (response.ok) {
        if (attempts > 1) {
          log(`pkg.pr.new package became available after ${attempts} probes`);
        }
        return;
      }

      lastFailure = `HTTP ${response.status}`;
      if (
        response.status !== 404 &&
        response.status !== 408 &&
        response.status !== 425 &&
        response.status !== 429 &&
        response.status < 500
      ) {
        throw new Error(`pkg.pr.new package probe failed permanently: ${lastFailure}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("pkg.pr.new package probe failed")) {
        throw error;
      }
      lastFailure = error instanceof Error ? error.message : String(error);
    }

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `pkg.pr.new package was not published within ${Math.round(timeoutMs / 1000)}s (${lastFailure})`,
      );
    }
    if (attempts === 1) {
      log(`waiting for pkg.pr.new package publication (${lastFailure})`);
    }
    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsedMs));
  }
}
