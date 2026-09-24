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
 */
export async function depotCiApi(method: string, body: object, token: string): Promise<unknown> {
  const response = await fetch(`https://api.depot.dev/depot.ci.v1.CIService/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-depot-org": DEPOT_ORG,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Depot ${method} returned HTTP ${response.status}`);
  return response.json();
}
