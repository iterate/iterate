// The "middle option" reproduction (see oversized-settlement-crash.test.ts for
// the lighter, hand-rolled sibling). Same 2026-09-02 incident, but the child
// drives the REAL stream-processing machinery — a real StreamEventLog, a
// ProcessorStream adapter over it, and two real StreamProcessorRunner folds
// (AgentProcessor + CapabilityHostProcessor, the facets that shared the dead
// DO's isolate) — so the re-materialization is genuine runner+fold work rather
// than hand-called classifiers. Node heap (--max-old-space-size) still stands
// in for the workerd 128MiB isolate cap, shared in production with the agent's
// contextItems, connections, and the ephemeral buffer, so the fan-out never
// had a full 128MiB to itself.
//
// Measured splits (deterministic, three repeats each):
//   incident (~7.3M chars) → V8 aborts: "Ineffective mark-compacts … out of memory"
//   control  (3k chars)    → SURVIVED, ~43MB heap (real runners carry more
//                            baseline than the hand-rolled sibling's ~19MB)
// Same child both runs; only the payload size differs.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { failing } from "@iterate-com/shared/test-support/failing-test";

const CHILD = fileURLToPath(
  new URL("./oversized-settlement-crash-realprocessors.child.ts", import.meta.url),
);
const ISOLATE_BUDGET_MB = 96;
const INCIDENT_CHARS = 7_260_000; // the prod settlement was 7,051KB
const CONTROL_CHARS = 3_000;

// Every V8 out-of-memory spelling — the node stand-in for the isolate reset.
// A heap blow-up surfaces as any of these depending on where GC gives up.
const OOM_SIGNATURE =
  /Reached heap limit|JavaScript heap out of memory|Ineffective mark-compacts|Allocation failed/;

type ReplayOutcome =
  | { kind: "survived"; output: string }
  | { kind: "oom"; output: string }
  | { kind: "other-failure"; output: string };

/** Run the replay child at the isolate budget and classify: clean exit
 * ("survived"), a genuine V8 OOM ("oom"), or any other abort
 * ("other-failure" — which must NOT be mistaken for the pinned crash). */
function runReplay(resultChars: number): ReplayOutcome {
  try {
    const output = execFileSync(
      process.execPath,
      [`--max-old-space-size=${ISOLATE_BUDGET_MB}`, "--import", "tsx", CHILD, String(resultChars)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
    );
    return { kind: "survived", output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return { kind: OOM_SIGNATURE.test(output) ? "oom" : "other-failure", output };
  }
}

describe("stream DO isolate under an oversized settlement (real processors)", () => {
  // Guard rail: the real folds + deliveries over a small settlement fit the
  // budget comfortably. If this fails, the fixture is what OOMs, not the bug.
  it("survives comfortably when the settlement is small", () => {
    const control = runReplay(CONTROL_CHARS);
    expect(control.kind).toBe("survived");
    expect(control.output).toContain("SURVIVED");
  });

  // Pinned prod incident: StreamDurableObject 50703abf…d9e01 (os-prd). The
  // real AgentProcessor + CapabilityHostProcessor folds re-materialize the 7MB
  // settlement (reduceAgentEvent render + retainedScriptResult classification)
  // and OOM the isolate — "Durable Object's isolate exceeded its memory limit
  // and was reset" (traces 2f4ac441… / 78d9c657…), then wake-looped for hours.
  //
  // Desired behavior: the fold fan-out fits the budget because the settlement
  // was bounded before it was journaled. Today it OOMs. See the sibling test's
  // notes on the single-assertion / label-matching mechanism.
  const failOOM = failing(it, /Incident kind: oom/);
  failOOM("survives the real folds re-materializing an oversized settlement", () => {
    const incident = runReplay(INCIDENT_CHARS);
    const message = `Incident kind: ${incident.kind}. Budget: ${ISOLATE_BUDGET_MB}MB. Output:\n${incident.output.slice(-500)}`;
    expect(incident.output, message).toContain("SURVIVED");
  });
});
