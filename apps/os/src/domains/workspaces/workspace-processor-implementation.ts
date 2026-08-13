import { mergeProcessorConfig, StreamProcessor } from "iterate/processors";
import type { ReduceArgs } from "iterate/processors";
import {
  WorkspaceProcessorContract,
  type WorkspaceConfig,
  type WorkspaceConfigPatch,
} from "./workspace-processor-contract.ts";

/**
 * The workspace lifecycle processor: a PURE REDUCER of the birth certificate
 * and configuration patches into `{ birthCertificate, config }` — existence
 * plus the mount OVERLAY table. The live routing table is those overlays
 * merged over the DERIVED default (every project repo mounted at its own
 * /repos/** path) by `effectiveWorkspaceMounts` in the hosting Durable Object.
 *
 * HOW IT WORKS, end to end: `workspace/created` is the existence marker — the
 * first one wins; every `workspace/configured` event carries a patch that
 * {@link mergeWorkspaceConfigPatch} deep-merges per mount point (unknown keys
 * add overlays, partial values edit one overlay's fields, `null` clears one).
 *
 * Deliberately NO `processEvent` and no side-effect lanes: the workspace
 * Durable Object is the imperative actor (it appends these events, serves the
 * filesystem, and runs the commit lanes); this class exists so the overlay
 * table is event-sourced state with the platform's ordinary
 * created/configured semantics. Because nothing here ever starts background
 * work, the DO registers it with NO recovery — an eviction can never lose a
 * consequence.
 *
 * The reduce is deliberately TOLERANT: a committed event is a fact of the
 * stream, and a throw here would wedge the cursor on it forever. A second
 * `created` is skipped (first marker wins). The DO's configure door validates
 * the EFFECTIVE table loudly BEFORE appending, so callers get errors while
 * the stream stays unpoisonable.
 */
export class WorkspaceProcessor extends StreamProcessor<WorkspaceProcessorContract> {
  readonly contract = WorkspaceProcessorContract;

  protected override reduce({ event, state }: ReduceArgs<WorkspaceProcessorContract>) {
    switch (event.type) {
      case "events.iterate.com/workspace/created":
        // FIRST marker wins. A second created event (a raw append under a
        // different idempotency key is schema-valid) is skipped, never
        // thrown on — a committed fact must not wedge the reduce. Pre-0.4.0
        // payloads carried the initial mount table; it is ignored — mounts
        // are derived now.
        if (state.birthCertificate) return state;
        return { ...state, birthCertificate: event.payload };
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
 * Merge one configuration patch into the stored overlay table: the platform's
 * deep merge (plain objects recurse; scalars and `null` replace), then mount
 * entries that are `null` (the clear marker) are DROPPED, and the result
 * re-parses through the contract's own config schema. Dropping — not throwing
 * — is load-bearing: this runs in the reducer, where a committed event is a
 * fact of the stream and a throw would wedge the cursor on it forever. The
 * DO's configure door additionally validates that every surviving overlay
 * forms a complete mount in the EFFECTIVE table and rejects loudly before the
 * append, so callers get the error while the stream stays unpoisonable.
 */
export function mergeWorkspaceConfigPatch(
  base: WorkspaceConfig,
  patch: WorkspaceConfigPatch,
): WorkspaceConfig {
  const merged = mergeProcessorConfig(base, patch) as { mounts?: Record<string, unknown> };
  const mounts = Object.fromEntries(
    // `null` is the clear marker (the derived default returns); partial
    // overlays are kept as stored deviations.
    Object.entries(merged.mounts ?? {}).filter(([, mount]) => !!mount),
  );
  return WorkspaceProcessorContract.stateSchema.shape.config.parse({ ...merged, mounts });
}
