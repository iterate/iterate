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

/** Run the replay child at the isolate budget; return its outcome. */
function runReplay(resultChars: number): { crashed: boolean; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [`--max-old-space-size=${ISOLATE_BUDGET_MB}`, "--import", "tsx", CHILD, String(resultChars)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
    );
    return { crashed: false, output };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return { crashed: true, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("stream DO isolate under an oversized script settlement", () => {
  // The guard rail: the same replay with a small result must sail through the
  // budget. If this ever fails, the fixture — not the bug — is what OOMs, and
  // the pin below would be lying. Real product code, real crash channel, so
  // this proves the fan-out itself is cheap when the settlement is bounded.
  it("survives comfortably when the settlement is small", () => {
    const control = runReplay(CONTROL_CHARS);
    expect(control.crashed).toBe(false);
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
  // deadline (below the unit lane's 45s runner timeout, per its contract) is
  // ample — a hang fails as NOT-the-pinned-failure rather than masquerading
  // as the crash.
  const isolateSurvives = failing(it, /stream DO isolate OOMed/);
  isolateSurvives("survives the readers re-materializing an oversized settlement", () => {
    const incident = runReplay(INCIDENT_CHARS);
    if (incident.crashed) {
      // The pinned failure: V8 aborted the replay exactly as the production
      // isolate reset. `failing` matches this message and stays green while
      // the bug lives; once #2572 bounds the settlement the child SURVIVES,
      // this branch is not taken, the body passes, and the pin flips red
      // with instructions to delete the wrapper.
      throw new Error(
        `stream DO isolate OOMed re-materializing an oversized settlement ` +
          `(budget ${ISOLATE_BUDGET_MB}MB): ${incident.output.slice(-400)}`,
      );
    }
    expect(incident.output).toContain("SURVIVED");
  });
});
