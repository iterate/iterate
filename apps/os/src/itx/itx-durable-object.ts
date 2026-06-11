// ItxDurableObject: the GENERIC context host — one instance per extended
// context (an agent session, a REPL scratchpad, an MCP session's context).
//
// It holds NO configuration: its NAME is the journal coordinate
// (`<namespace>:<journalPath>`, journal.ts), so identity, journal ref, and
// self-address are projections of the name; parentage arrives as the
// journal's first event (the birth certificate) and folds into state like
// everything else. The DO's private storage holds only the processor
// checkpoint — a disposable cache of the fold.
//
// Capability resolution walks the chain child → parent (→ … → the
// platform context): the core delegates a miss per call through the parent
// address recorded in the birth certificate. Shadowing is allowed and
// VISIBLE: describe() returns the merged chain with each entry's owner.

import { DurableObject } from "cloudflare:workers";
import { Itx, type CapabilityAddress, type ItxStub } from "./itx.ts";
import { makeDial, durableObjectFacetsHook, resolveDialableTargets } from "./dial.ts";
import {
  childContextAddress,
  contextIdOfJournalPath,
  dialContext,
  journalStream,
  parseItxDurableObjectName,
  type ContextDescriptor,
  type ItxJournalRef,
} from "./journal.ts";
import { runItxScript } from "./run.ts";
import type { ItxRuntime } from "./handle.ts";
import { parseConfig } from "~/config.ts";

export class ItxDurableObject extends DurableObject<Env> {
  #itx: Itx | null = null;

  /** The journal coordinate — a pure projection of the DO name. */
  #journal(): ItxJournalRef {
    const name = this.ctx.id.name;
    if (!name)
      throw new Error("ItxDurableObject must be addressed by name (its journal coordinate).");
    return parseItxDurableObjectName(name);
  }

  /** This node's own address — the save() half of the SturdyRef story. */
  address(): CapabilityAddress {
    return childContextAddress(this.#journal());
  }

  /** Identity, name, and parentage, derived from the journal fold — there is
   * no descriptor table. Throws until the birth certificate exists. */
  async descriptor(): Promise<ContextDescriptor> {
    const journal = this.#journal();
    const record = await this.itx().contextRecord();
    if (!record || !record.parent) {
      throw new Error(
        `Context ${contextIdOfJournalPath(journal.path)} has no birth certificate yet — ` +
          `extend a context to create one (the context-created event is the journal's first).`,
      );
    }
    return {
      id: record.id,
      name: record.name,
      parent: record.parent,
      projectId: journal.namespace,
    };
  }

  /**
   * This context's core. Materializes lazily by consuming its journal; the
   * parent link dials the address from the birth certificate per call
   * (Workers RPC stubs are request-scoped in a DO, so a held stub would go
   * stale). The checkpoint lives in this DO's storage — a disposable cache.
   */
  itx(): Itx {
    if (this.#itx) return this.#itx;
    const journal = this.#journal();
    const contextId = contextIdOfJournalPath(journal.path);
    const selfAddress = childContextAddress(journal);
    const parentNode = (): ItxStub | null => {
      const parent = this.#itx?.state.context?.parent;
      if (!parent) return null;
      const node = () => dialContext(this.env, parent.address as CapabilityAddress);
      return {
        describe: () => node().itx().describe(),
        invoke: (input) => node().itx().invoke(input),
        provideCapability: (input) => node().itx().provideCapability(input),
        revokeCapability: (input) => node().itx().revokeCapability(input),
      };
    };
    // Legacy pre-journal residue (the itx_capabilities/itx_context SQLite
    // tables) is dead weight on old instances: drop on sight, never read.
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS itx_capabilities`);
    this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS itx_context`);
    this.#itx = new Itx({
      contextId,
      dial: makeDial({
        allowlists: resolveDialableTargets(parseConfig(this.env).itx),
        contextAddress: selfAddress,
        contextId,
        env: this.env,
        exports: this.ctx.exports as unknown as Parameters<typeof makeDial>[0]["exports"],
        facets: durableObjectFacetsHook(this.ctx),
        loader: (this.env as { LOADER?: unknown }).LOADER as Parameters<
          typeof makeDial
        >[0]["loader"],
        projectId: journal.namespace,
      }),
      iterateContext: { journal: journalStream(this.env, journal) },
      keepAliveWhile: (work) => this.ctx.waitUntil(work()),
      parentItx: parentNode,
      readState: async () =>
        await this.ctx.storage.get<{ offset: number; state: Itx["state"] }>("itx-checkpoint"),
      // Processor-mode execution: an enqueued script-execution-requested on
      // this journal runs here, and the runner appends the completed event
      // back onto the same journal — the record stays self-contained.
      runScript: (input) =>
        runItxScript({
          contextAddress: selfAddress,
          env: this.env,
          executionId: input.executionId,
          exports: this.ctx.exports as unknown as ItxRuntime["exports"],
          functionSource: input.code,
          projectId: journal.namespace,
          props: { context: contextId },
          record: journal,
          recordRequested: false,
        }),
      selfAddress,
      writeState: async (snapshot) => {
        await this.ctx.storage.put("itx-checkpoint", snapshot);
      },
    });
    return this.#itx;
  }
}
