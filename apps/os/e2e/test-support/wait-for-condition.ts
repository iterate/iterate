/**
 * Poll `predicate` until truthy; throw `Timed out waiting for <description>`
 * on deadline. The one polling loop shared by the e2e suites and the tui
 * data-layer smoke (which injects an event-driven `sleep`).
 */
export async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  opts: {
    /** What we were waiting for — a string, or a lazy one for live detail. */
    description: string | (() => string);
    intervalMs?: number;
    timeoutMs?: number;
    /** Custom sleeper between polls (e.g. a change-notification wake). */
    sleep?: (intervalMs: number) => Promise<void>;
  },
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 50;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  const description =
    typeof opts.description === "function" ? opts.description() : opts.description;
  throw new Error(`Timed out waiting for ${description}`);
}
