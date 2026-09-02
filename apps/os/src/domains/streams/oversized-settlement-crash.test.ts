// The 2026-09-02 stream-DO death, reproduced as an actual out-of-memory crash
// rather than the mere fact that a payload can be large.
//
// The child process (oversized-settlement-crash.child.ts) replays the incident
// with real product code — the settlement journals through scriptCompletionInput
// into the real chunk-blob StreamEventLog over node:sqlite, then the readers the
// production trace shows sharing the dead DO's isolate re-materialize it
// concurrently (six delivery cursors each holding batch + serialized send body,
// the two processor folds' page reads, the capability-host fold's retained-row
// classification, the agent fold's render stringifications). We run it under
// --max-old-space-size=96 — comfortably below the DO's 128MiB isolate budget,
// which in production is further shared with the agent's whole contextItems
// state, connections, and the ephemeral buffer, so the fan-out never had a full
// 128MiB to itself.
//
// Measured splits (this file's fixture, three repeats each, deterministic):
//   incident payload (~7.3M chars) → V8 aborts: "Reached heap limit … out of memory"
//   control payload (3k chars)     → SURVIVED, ~19MB heap
// The child is the SAME code either way; only the payload size differs, so the
// crash is caused by the unbounded settlement and nothing else.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { failing } from "@iterate-com/shared/test-support/failing-test";

const CHILD = fileURLToPath(new URL("./oversized-settlement-crash.child.ts", import.meta.url));
const ISOLATE_BUDGET_MB = 96;
const INCIDENT_CHARS = 7_260_000; // the prod settlement was 7,051KB
const CONTROL_CHARS = 3_000;

// V8's out-of-memory abort signature — the node spelling of the production
// isolate reset. This is what distinguishes the pinned bug from ANY other
// child failure (an import error, a fixture bug, a timeout): only these
// messages count as the crash.
const OOM_SIGNATURE = /Reached heap limit|JavaScript heap out of memory/;

type ReplayOutcome =
  | { kind: "survived"; output: string }
  | { kind: "oom"; output: string }
  | { kind: "other-failure"; output: string };

/** Run the replay child at the isolate budget and classify its outcome:
 * clean exit ("survived"), a genuine V8 OOM ("oom"), or any other abort
 * ("other-failure" — which must NOT be mistaken for the pinned crash). */
function runReplay(resultChars: number): ReplayOutcome {
  try {
    const output = execFileSync(
      process.execPath,
      [`--max-old-space-size=${ISOLATE_BUDGET_MB}`, "--import", "tsx", CHILD, String(resultChars)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
    );
    return { kind: "survived", output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    return { kind: OOM_SIGNATURE.test(output) ? "oom" : "other-failure", output };
  }
}

describe("stream DO isolate under an oversized script settlement", () => {
  // The guard rail: the same replay with a small result must sail through the
  // budget. If this ever fails, the fixture — not the bug — is what OOMs, and
  // the pin below would be lying. Real product code, real crash channel, so
  // this proves the fan-out itself is cheap when the settlement is bounded.
  it("survives comfortably when the settlement is small", () => {
    const control = runReplay(CONTROL_CHARS);
    expect(control.kind).toBe("survived");
    expect(control.output).toContain("SURVIVED");
  });

  // Pinned prod incident: StreamDurableObject 50703abf…d9e01 (os-prd), whose
  // alarm-driven facet catch-up over the 7MB settlement at offset 2381 died
  // with "Durable Object's isolate exceeded its memory limit and was reset"
  // (traces 2f4ac441… / 78d9c657…), then wake-looped for hours.
  //
  // Desired behavior: the same fan-out fits the isolate budget, because the
  // settlement was bounded before it was journaled. Today it OOMs instead.
  // The replay child OOMs in a few seconds, so the wrapper's default 30s
  // deadline (below the apps/os unit tests' 45s runner timeout, per its contract) is
  // ample — a hang fails as NOT-the-pinned-failure rather than masquerading
  // as the crash.
  //
  // One assertion carries all three outcomes, and the `Incident kind: <kind>`
  // label in its failure message is what the pin keys on:
  // - oom (bug present)     → no SURVIVED, assertion fails, message says
  //                           "Incident kind: oom" → matches → pin green.
  // - survived (bug fixed)  → SURVIVED present, assertion passes, body
  //                           succeeds → failing() flips red: delete the wrapper.
  // - other-failure         → no SURVIVED, assertion fails, but the message
  //   (import error, fixture   says "Incident kind: other-failure" → does NOT
  //   bug, timeout)           match → failing() reports red. A child abort that
  //                           is not a real OOM proves nothing and must not hold
  //                           the pin, per failing()'s contract.
  const failOOM = failing(it, /Incident kind: oom/);
  failOOM("survives the readers re-materializing an oversized settlement", () => {
    const incident = runReplay(INCIDENT_CHARS);
    const message = `Incident kind: ${incident.kind}. Budget: ${ISOLATE_BUDGET_MB}MB. Output:\n${incident.output.slice(-500)}`;
    expect(incident.output, message).toContain("SURVIVED");
  });
});
