// Context ADDRESSES (itx-next.md "The address unification"): a context is
// anything answering the context protocol (the itx* verbs); its ADDRESS is a
// cap target — "how to dial the node that owns this identity". Identity (the
// string id: "global", a project id, "ctx_…") stays identity — audit,
// workspace scoping, and origin-carrying keep using ids; this module is THE
// one place the id→address mapping lives, replacing the prefix-sniffing that
// used to be scattered across the restorer, the handle, and parentStub.

import {
  GLOBAL_CONTEXT_ID,
  isChildContextId,
  type CapabilityDescription,
  type CapabilityInvoke,
  type CapabilityMeta,
  type PathCall,
  type SerializableCapabilityTarget,
} from "./protocol.ts";
import type { ContextDescriptor } from "./context-do.ts";
import type { LiveCapabilityTarget } from "./registry.ts";
import { getProjectDurableObjectName } from "~/domains/projects/durable-objects/project-durable-object.ts";

/** A context's address IS a cap target — one data structure for everything. */
export type ContextAddress = SerializableCapabilityTarget;

/** The Durable Object namespace bindings that host context nodes today. */
const CHILD_CONTEXT_BINDING = "ITX_CONTEXT";
const PROJECT_CONTEXT_BINDING = "PROJECT";

/**
 * The context protocol: what any dialed context node answers. Both the
 * Project DO (project contexts) and ContextDO (children) speak it over
 * Workers RPC.
 */
export type ContextNodeStub = {
  itxProvideCapability(input: {
    name?: string;
    path?: string[];
    target: SerializableCapabilityTarget | LiveCapabilityTarget;
    invoke?: CapabilityInvoke;
    meta?: CapabilityMeta;
  }): Promise<unknown>;
  itxRevokeCapability(input: { name?: string; path?: string[] }): Promise<unknown>;
  itxDescribe(): Promise<CapabilityDescription[]>;
  itxInvoke(input: PathCall & { origin?: string }): Promise<unknown>;
  /** Child-context nodes (ContextDO) also expose their descriptor — the one
   * lookup a sturdy ref costs to learn the owning project. The Project DO
   * does not implement it (its identity IS its project): gate on
   * {@link isChildContextAddress} before calling. */
  descriptor?(): Promise<ContextDescriptor>;
};

/** The id→address mapping — the save() half of the SturdyRef story. */
export function contextAddressOf(contextId: string): ContextAddress {
  if (contextId === GLOBAL_CONTEXT_ID) {
    throw new Error(
      "The global context has no node to dial yet — global handles are minted " +
        "at connect time (itx-next.md, address unification step (c)).",
    );
  }
  if (isChildContextId(contextId)) {
    return {
      type: "rpc",
      worker: { type: "durable-object", binding: CHILD_CONTEXT_BINDING, name: contextId },
    };
  }
  // Anything else is a project id: the Project DO hosts the project context.
  return {
    type: "rpc",
    worker: {
      type: "durable-object",
      binding: PROJECT_CONTEXT_BINDING,
      name: getProjectDurableObjectName(contextId),
    },
  };
}

/** Does this address dial a child-context node (a ContextDO)? Keyed off the
 * structured address, never an id prefix. */
export function isChildContextAddress(address: ContextAddress): boolean {
  return (
    address.type === "rpc" &&
    address.worker.type === "durable-object" &&
    address.worker.binding === CHILD_CONTEXT_BINDING
  );
}

/**
 * The restore() half: resolve an address to a live stub speaking the context
 * protocol. This dial is KERNEL plumbing for addresses written by trusted
 * code (fork, the restorer) — it is deliberately NOT gated by the DIALABLE_*
 * allowlists: provider-supplied cap targets stay gated inside the registry;
 * parent addresses are written only by kernel code, never by handle holders.
 */
export function dialContext(env: Env, address: ContextAddress): ContextNodeStub {
  if (address.type === "url") {
    throw new Error("url context addresses are not dialable yet (federation is a later wave).");
  }
  const worker = address.worker;
  switch (worker.type) {
    case "durable-object": {
      const namespace = (env as unknown as Record<string, unknown>)[worker.binding] as
        | { getByName(name: string): unknown }
        | undefined;
      if (typeof namespace?.getByName !== "function") {
        throw new Error(
          `Context address binding "${worker.binding}" is not a Durable Object namespace on this host.`,
        );
      }
      return namespace.getByName(worker.name) as ContextNodeStub;
    }
    case "loopback":
      throw new Error(
        "Loopback context addresses are not dialable yet — the stateless global/defaults " +
          "contexts land with itx-next.md address unification step (c).",
      );
    case "binding":
    case "source":
      throw new Error(`"${worker.type}" worker refs cannot address a context node.`);
  }
}
