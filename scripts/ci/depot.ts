/** Iterate's Depot organization, which runs every workflow in .depot/workflows (docs/depot-ci.md). */
export const DEPOT_ORG = "0p91s0lz49";

/** `operation` over `inputs`, at most `concurrency` at a time, outputs in input order: how the
 *  telemetry sync and the flake dashboard fan out their per-run Depot calls. */
export async function mapConcurrent<Input, Output>(
  inputs: Input[],
  concurrency: number,
  operation: (input: Input) => Promise<Output>,
) {
  const outputs = new Array<Output>(inputs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= inputs.length) return;
        outputs[index] = await operation(inputs[index]!);
      }
    }),
  );
  return outputs;
}

/**
 * One call to Depot's CI API, the Connect JSON protocol the Depot CLI itself speaks. The methods and
 * their fields are in https://github.com/depot/cli/blob/main/proto/depot/ci/v1/ci.proto (JSON uses
 * the camelCase field names). `token` is an organization API token (`DEPOT_CI_TELEMETRY_TOKEN`).
 *
 * A read (`Get…`, `List…`, the only methods CI calls) that Depot answers with a 5xx, or whose
 * connection fails, is asked again after each of `delaysMs`, with a `depot.platform-failure-retry`
 * warn per repeat; then the last failure is thrown, so a lasting outage still fails the job, about
 * 17 s later. A 4xx is an answer about the request and fails at once, as does any other method
 * (Connect sends every call as a POST, so only the name says it changes nothing). One 500 on
 * GetJobAttemptLogs failed PR #2970's Preview OS trace job (attempt 144gszhm0r, 2026-09-24).
 */
export async function depotCiApi(
  method: string,
  body: object,
  token: string,
  options: { fetch?: typeof fetch; delaysMs?: readonly number[] } = {},
): Promise<unknown> {
  const { fetch: fetchImpl = fetch, delaysMs = [2_000, 5_000, 10_000] } = options;
  for (let attempt = 1; ; attempt++) {
    const delayMs = /^(Get|List)[A-Z]/.test(method) ? delaysMs[attempt - 1] : undefined;
    let failure: { status: number | "network"; error: Error };
    try {
      const response = await fetchImpl(`https://api.depot.dev/depot.ci.v1.CIService/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-depot-org": DEPOT_ORG,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return await response.json();
      await response.body?.cancel();
      const error = new Error(`Depot ${method} returned HTTP ${response.status}`);
      if (response.status < 500 || delayMs === undefined) throw error;
      failure = { status: response.status, error };
    } catch (error) {
      // fetch rejects with a TypeError when the connection fails; a timeout or an abort is not
      // Depot's answer and is thrown as it is.
      if (!(error instanceof TypeError) || delayMs === undefined) throw error;
      failure = { status: "network", error };
    }
    console.warn({
      event: "depot.platform-failure-retry",
      method,
      status: failure.status,
      message: failure.error.message,
      attempt,
      retryInMs: delayMs,
    });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}
