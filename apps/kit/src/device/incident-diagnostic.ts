export type IncidentDiagnosticResult =
  | { ok: true; value: unknown }
  | { error: { message: string; name: string }; ok: false };

export interface IncidentDiagnosticOptions {
  label: string;
  timeoutMs: number;
}

/**
 * Captures one secondary incident probe without letting it consume the primary
 * evidence artifact.
 *
 * A capability RPC that never settles is not an exotic harness condition: it
 * is a likely consequence of the same control/PCM failure under investigation.
 * Provider events are already durable by the time this helper runs, so waiting
 * without a bound would invert their importance and leave the operator with no
 * artifact at all. The underlying connection is disposed by the collector
 * after this result is printed; this helper only bounds observation and does
 * not pretend it can cancel an arbitrary Cap'n Web promise.
 */
export async function captureIncidentDiagnostic(
  operation: () => Promise<unknown>,
  options: IncidentDiagnosticOptions,
): Promise<IncidentDiagnosticResult> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError("Incident diagnostic timeout must be a positive integer.");
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`${options.label} did not settle within ${options.timeoutMs} ms.`);
      error.name = "IncidentDiagnosticTimeoutError";
      reject(error);
    }, options.timeoutMs);
  });

  try {
    return { ok: true, value: await Promise.race([operation(), deadline]) };
  } catch (error) {
    return {
      error: {
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : "Error",
      },
      ok: false,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
