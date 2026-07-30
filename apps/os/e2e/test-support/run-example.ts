// The door between the examples catalogue and arbitrary e2e tests: a test
// that exercises a user-facing pattern runs the catalogue entry ITSELF (by
// id) and owns the assertions on top — the entry stays the single source of
// truth, proven wherever it is used. Probes — protocol semantics,
// concurrency blasts, incident repros, malformed input — use itxScript()
// instead and are never catalogue entries.

import { ITX_EXAMPLES, runScriptEnvelope } from "../../src/itx/examples.ts";
import type { RunScriptHost } from "./itx-script-builder.ts";

export { runScriptEnvelope };

/** Execute a catalogue example by id through `capabilityHost.runScript`. */
export async function runExample(
  id: string,
  input: { capabilityHost: RunScriptHost; vars?: Record<string, unknown> },
): Promise<unknown> {
  const example = ITX_EXAMPLES.find((entry) => entry.id === id);
  if (!example) {
    throw new Error(
      `Unknown example id "${id}". Known ids: ${ITX_EXAMPLES.map((entry) => entry.id).join(", ")}`,
    );
  }
  const execution = await input.capabilityHost.runScript(
    runScriptEnvelope(example.code, input.vars ?? {}),
  );
  return execution.result;
}
