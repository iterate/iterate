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
