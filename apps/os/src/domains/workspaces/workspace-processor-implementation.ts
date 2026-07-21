import { mergeProcessorConfig, StreamProcessor } from "iterate/processors";
import type { ReduceArgs } from "iterate/processors";
import {
  WorkspaceProcessorContract,
  type WorkspaceConfig,
  type WorkspaceConfigPatch,
} from "./workspace-processor-contract.ts";

/**
 * The workspace lifecycle processor: a PURE REDUCER of the birth certificate
 * and configuration patches into `{ birthCertificate, config }` — the mount
 * table every workspace operation routes by.
 *
 * HOW IT WORKS, end to end: `workspace/created` is the birth certificate —
 * the first one wins and seeds `config` with the complete initial mount
 * table; every `workspace/configured` event carries a patch that
 * {@link mergeWorkspaceConfigPatch} deep-merges per mount point (unknown keys
 * add mounts, partial values edit one mount's fields, `null` unmounts). Any
 * incarnation that reduces the stream knows the exact table the workspace's
 * fall-through reads and commits must route by.
 *
 * Deliberately NO `processEvent` and no side-effect lanes: the workspace
 * Durable Object is the imperative actor (it appends these events, serves the
 * filesystem, and runs the commit lanes); this class exists so the mount
 * table is event-sourced state with the platform's ordinary
 * created/configured semantics. Because nothing here ever starts background
 * work, the DO registers it with NO recovery — an eviction can never lose a
 * consequence.
 *
 * The reduce is deliberately TOLERANT: a committed event is a fact of the
 * stream, and a throw here would wedge the cursor on it forever. A second
 * `created` is skipped (first certificate wins); a `configured` patch entry
 * that never forms a complete mount is dropped. The DO's configure door runs
 * the SAME merge and rejects loudly BEFORE appending, so callers get the
 * error while the stream stays unpoisonable.
 */
export class WorkspaceProcessor extends StreamProcessor<WorkspaceProcessorContract> {
  readonly contract = WorkspaceProcessorContract;

  protected override reduce({ event, state }: ReduceArgs<WorkspaceProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/workspace/created":
        // FIRST certificate wins. A second created event (a raw append under
        // a different idempotency key is schema-valid) is skipped, never
        // thrown on — a committed fact must not wedge the reduce.
        if (state.birthCertificate !== null) return state;
        return { ...state, birthCertificate: event.payload, config: event.payload.config };
      case "events.iterate.com/workspace/configured":
        return {
          ...state,
          config: mergeWorkspaceConfigPatch(state.config, event.payload.config),
        };
      default:
        return state;
    }
  }
}

// -----------------------------------------------------------------------------
// Pure helpers — shared with the workspace Durable Object's configure door.
// -----------------------------------------------------------------------------

/**
 * Merge one configuration patch into a complete configuration: the platform's
 * deep merge (plain objects recurse; scalars and `null` replace), then mount
 * entries that are `null` (the unmount marker) or that never formed a
 * COMPLETE mount (a partial patch for a key with no existing mount to merge
 * into) are DROPPED, and the result re-parses through the contract's own
 * config schema. Dropping — not throwing — is load-bearing: this runs in the
 * reducer, where a committed event is a fact of the stream and a throw would
 * wedge the cursor on it forever. The DO's configure door makes the same
 * merge and then loudly rejects patches whose entries did not survive, so
 * callers get the error while the stream stays unpoisonable.
 */
export function mergeWorkspaceConfigPatch(
  base: WorkspaceConfig,
  patch: WorkspaceConfigPatch,
): WorkspaceConfig {
  const merged = mergeProcessorConfig(base, patch) as { mounts?: Record<string, unknown> };
  const mounts = Object.fromEntries(
    // Completeness is structural (both fields present): on the reducer path
    // every input is already schema-valid (base = prior parses, patch = the
    // event's payload schema), so a structurally complete entry IS a valid
    // mount; on the door path the re-parse below still rejects any smuggled
    // invalid value loudly before it can become an append.
    Object.entries(merged.mounts ?? {}).filter(([, mount]) => isCompleteMount(mount)),
  );
  return WorkspaceProcessorContract.stateSchema.shape.config.parse({ ...merged, mounts });
}

function isCompleteMount(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { policy?: unknown }).policy === "string" &&
    typeof (value as { repoPath?: unknown }).repoPath === "string"
  );
}
