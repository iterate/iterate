export async function waitFor(params: {
  timeoutMs: number;
  intervalMs?: number;
  fn: () => Promise<boolean>;
  label: string;
}): Promise<void> {
  const { timeoutMs, fn, label } = params;
  const intervalMs = params.intervalMs ?? 500;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await fn()) return;
    } catch {
      // Transient startup failures are expected during polling.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${label}`);
}
