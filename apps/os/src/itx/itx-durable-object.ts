// ItxDurableObject: THE context host — one instance per context, named by
// the context's REF (`<projectId>:<path>`, coordinates.ts). The project
// context, agent contexts, MCP-session contexts, and anonymous extensions
// are all instances of this one class; no other Durable Object hosts an Itx.
//
// The host derives NOTHING beyond its coordinate: parentage and naming
// arrive as the `context-created` event its CREATOR appended to the stream
// (coordinates.ts createContext), and fold into state like everything else.
// The stream pushes batches here through the subscription the creator
// configured (the "itx" processor below); provides still self-ingest for
// read-your-writes. The DO's private storage holds only the processor
// checkpoint — a disposable cache of the fold — plus any facet caps' SQLite.
//
// Capability resolution walks the chain child → parent (→ … → the
// defaults): the core delegates a miss per call through the parent address
// recorded in the birth certificate. Shadowing is allowed and VISIBLE:
// describe() returns the merged chain — inherited entries carry `from`, own
// entries carry no provenance field.

import { DurableObject } from "cloudflare:workers";
import { Itx, ItxContract, type CapabilityAddress, type ItxStub } from "./itx.ts";
import { makeDial, durableObjectFacetsHook, resolveDialableTargets } from "./dial.ts";
import {
  contextAddress,
  contextStream,
  dialCodeContext,
  dialContext,
  isContextNodeAddress,
  parseContextRef,
  type ContextDescriptor,
} from "./coordinates.ts";
import { runItxScript } from "./run.ts";
import type { ItxRuntime } from "./handle.ts";
import {
  createStreamProcessorHost,
  type RequestStreamSubscriptionArgs,
} from "~/domains/streams/engine/workers/stream-processor-host.ts";
import { parseConfig } from "~/config.ts";

export class ItxDurableObject extends DurableObject<Env> {
  host = createStreamProcessorHost(this.ctx);
  #itx: Itx = this.host.add(ItxContract.slug, (deps) => {
    const ref = this.#ref();
    const coordinate = parseContextRef(ref);
    const projectId = coordinate.projectId;
    if (projectId === null) {
      throw new Error("ItxDurableObject contexts must be project-scoped.");
    }
    const selfAddress = contextAddress(ref);
    return new Itx({
      ...deps,
      contextRef: ref,
      dial: makeDial({
        allowlists: resolveDialableTargets(parseConfig(this.env).itx),
        contextAddress: selfAddress,
        contextRef: ref,
        env: this.env,
        exports: this.ctx.exports as unknown as Parameters<typeof makeDial>[0]["exports"],
        facets: durableObjectFacetsHook(this.ctx),
        loader: (this.env as { LOADER?: unknown }).LOADER as Parameters<
          typeof makeDial
        >[0]["loader"],
        projectId,
      }),
      // The core appends/reads its OWN stream directly (dialed by name) —
      // never through the host's subscription-retained stub, which only
      // exists after the stream has dialed us.
      iterateContext: { stream: contextStream(this.env, coordinate) },
      parentItx: () => {
        const parent = this.#itx.state.context?.parent;
        if (!parent) return null;
        const address = parent.address as CapabilityAddress;
        // A CODE parent (the platform defaults, the agent defaults): a
        // loopback entrypoint answering the context protocol, dialed
        // in-process via ctx.exports with the props the creation event
        // baked in. Everything else is a context node.
        if (!isContextNodeAddress(address)) {
          return {
            from: parent.ref,
            stub: dialCodeContext({
              address,
              exports: this.ctx.exports as unknown as Parameters<
                typeof dialCodeContext
              >[0]["exports"],
              projectId,
            }),
          };
        }
        const node = () => dialContext(this.env, address);
        return {
          from: parent.ref,
          stub: {
            describe: () => node().itx().describe(),
            invoke: (input) => node().itx().invoke(input),
            provideCapability: (input) => node().itx().provideCapability(input),
            revokeCapability: (input) => node().itx().revokeCapability(input),
          } satisfies ItxStub,
        };
      },
      // Processor-mode execution: an enqueued script-execution-requested on
      // this context's stream runs here, and the runner appends the
      // completed event back onto the same stream.
      runScript: (input) =>
        runItxScript({
          env: this.env,
          executionId: input.executionId,
          exports: this.ctx.exports as unknown as ItxRuntime["exports"],
          functionSource: input.code,
          projectId,
          props: { context: ref },
          record: coordinate,
          recordRequested: false,
        }),
      selfAddress,
    });
  });

  /** The context ref — a pure projection of the DO name. */
  #ref(): string {
    const name = this.ctx.id.name;
    if (!name) {
      throw new Error("ItxDurableObject must be addressed by name (its context ref).");
    }
    parseContextRef(name);
    return name;
  }

  /** This node's own address — the save() half of the SturdyRef story. */
  address(): CapabilityAddress {
    return contextAddress(this.#ref());
  }

  /** This context's core. A method, not a property: workerd does not
   * pipeline calls through property accesses, so `node.itx().invoke(…)`
   * stays one round trip. */
  itx(): Itx {
    return this.#itx;
  }

  /** Subscription callables on this context's stream dial this. */
  requestStreamSubscription(args: RequestStreamSubscriptionArgs): Promise<void> {
    return this.host.requestStreamSubscription(args);
  }

  /** Naming and parentage, derived from the fold of the creation event —
   * there is no descriptor table. Throws until the creator's
   * `context-created` event exists. */
  async descriptor(): Promise<ContextDescriptor> {
    const ref = this.#ref();
    const record = await this.#itx.contextRecord();
    if (!record || !record.parent) {
      throw new Error(
        `Context ${ref} has no creation event yet — its creator must append ` +
          `context-created (coordinates.ts createContext) before the chain can resolve.`,
      );
    }
    return {
      name: record.name,
      parent: { address: record.parent.address as CapabilityAddress, ref: record.parent.ref },
      ref,
    };
  }
}
