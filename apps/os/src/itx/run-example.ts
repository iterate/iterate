// The door between the examples catalogue and arbitrary callers: run a
// catalogue entry, by id, through `capabilityHost.runScript` — the same
// server-side script isolate agents use. Originally e2e-only test support;
// promoted here once apps/mobile needed the exact same envelope to run
// examples from the phone (no local JS eval, no Node-only deps — just this
// module plus the plain-data ITX_EXAMPLES array).

import type { CapabilityHost } from "../itx-api.generated.ts";
import { ITX_EXAMPLES } from "./examples.ts";

/** The run-script envelope every server-side runtime uses: the entry's body
 * with the call's vars serialized inline (see the CapabilityHost contract).
 * The e2e examples matrix proves this exact envelope via {@link runExample}
 * (its own runInRunScript case), not by calling this directly. */
function runScriptEnvelope(code: string, vars: Record<string, unknown>): string {
  return `async (itx) => {\nconst vars = ${JSON.stringify(vars)};\n${code}\n}`;
}

/** Execute a catalogue example by id through `capabilityHost.runScript`. */
export async function runExample(
  id: string,
  input: { capabilityHost: Pick<CapabilityHost, "runScript">; vars?: Record<string, unknown> },
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
