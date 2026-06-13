// The coordinate system: A CONTEXT IS A STREAM COORDINATE.
//
// Every context is `(namespace, path)` — an ordinary event stream. The
// project context lives at `(projectId, "/")`, an agent's at
// `(projectId, agentPath)`, an MCP session's at its session stream path, and
// anonymous extensions default to `/itx/<generated>` (a plain convention,
// not a reserved segment — any stream path can be a context). There are no
// context ids: the REF string `<namespace>:<path>` is the identity, and it
// is also the ItxDurableObject's name, so identity, stream, and address are
// the same fact spelled three ways.
//
// Creation is two appends BY THE CREATOR onto the context's own stream:
//
//   1. subscription-configured — points the stream at the generic host's
//      "itx" processor (the ItxDurableObject named with the ref), so the
//      stream pushes batches to the node.
//   2. context-created — the birth certificate: `{ name, parent }`. The
//      generic host derives NOTHING; parentage comes from this event.
//
// Both appends are idempotent by key, so creation is get-or-create: the
// first birth certificate wins and a re-create is inert.

import { StreamPath } from "@iterate-com/shared/streams/types";
import { typeid } from "@iterate-com/shared/typeid";
import { durableObjectProcessorSubscriber } from "@iterate-com/streams/shared/callable-subscriber";
import { ItxContract, ITX_EVENT_TYPES, type CapabilityAddress, type ContextStream } from "./itx.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";

/** Where one context lives: an ordinary stream coordinate. */
export type ItxCoordinate = { namespace: string; path: string };

const ITX_CONTEXT_BINDING = "ITX_CONTEXT";

/** The context REF: `<namespace>:<path>` — identity, stream coordinate, and
 * the ItxDurableObject name, all one string. */
export function formatContextRef(coordinate: ItxCoordinate): string {
  return `${coordinate.namespace}:${StreamPath.parse(coordinate.path)}`;
}

export function parseContextRef(ref: string): ItxCoordinate {
  const colon = ref.indexOf(":");
  if (colon <= 0 || ref[colon + 1] !== "/") {
    throw new Error(
      `A context ref is its stream coordinate ("<namespace>:/<path>"), got ${JSON.stringify(ref)}.`,
    );
  }
  return { namespace: ref.slice(0, colon), path: ref.slice(colon + 1) };
}

export function isContextRef(value: string): boolean {
  const colon = value.indexOf(":");
  return colon > 0 && value[colon + 1] === "/";
}

/** The project context's ref: the root of its own stream namespace. */
export function projectContextRef(projectId: string): string {
  return formatContextRef({ namespace: projectId, path: "/" });
}

/** The owning project of a context ref: its stream NAMESPACE. */
export function projectIdOfContextRef(ref: string): string {
  return parseContextRef(ref).namespace;
}

/** How to dial the node that owns a ref — the save() half of the SturdyRef
 * story. The ref IS the DO name. */
export function contextAddress(ref: string): CapabilityAddress {
  parseContextRef(ref); // refs are validated wherever they become addresses
  return {
    type: "rpc",
    worker: { binding: ITX_CONTEXT_BINDING, name: ref, type: "durable-object" },
  };
}

/** Does this address dial a context node (an ItxDurableObject)? */
export function isContextNodeAddress(address: CapabilityAddress): boolean {
  return address.worker.type === "durable-object" && address.worker.binding === ITX_CONTEXT_BINDING;
}

/** The ref inside a context-node address. */
export function contextRefOfAddress(address: CapabilityAddress): string {
  if (!isContextNodeAddress(address) || address.worker.type !== "durable-object") {
    throw new Error("Expected a context-node address.");
  }
  return address.worker.name;
}

/** What a dialed context NODE answers: its core (the itx() method — a
 * method, not a property, so `node.itx().invoke(...)` pipelines in one
 * round trip), plus the descriptor derived from the fold of its stream. */
export type ContextNodeStub = {
  itx(): import("./itx.ts").ItxStub;
  descriptor(): Promise<ContextDescriptor>;
};

export type ContextDescriptor = {
  ref: string;
  name: string | null;
  /** The parent context: its ref plus its ADDRESS — how chain delegation
   * and itx.super dial the parent node. */
  parent: { ref: string; address: CapabilityAddress };
};

/**
 * Dial a context node by ref or address. Kernel plumbing for refs written by
 * trusted code (creation events, the restorer) — deliberately NOT gated by
 * the dialable allowlists: provider-supplied cap addresses stay gated inside
 * the capability dial; context refs are written only by kernel code.
 *
 * Only durable-object context addresses dial here; CODE parents (loopback
 * entrypoints answering the context protocol) dial via
 * {@link dialCodeContext} on a host that holds `ctx.exports`.
 */
export function dialContext(env: Env, target: string | CapabilityAddress): ContextNodeStub {
  const ref = typeof target === "string" ? target : contextRefOfAddress(target);
  const namespace = (env as unknown as Record<string, unknown>)[ITX_CONTEXT_BINDING] as
    | { getByName(name: string): unknown }
    | undefined;
  if (typeof namespace?.getByName !== "function") {
    throw new Error(`The ${ITX_CONTEXT_BINDING} binding is not available on this host.`);
  }
  return namespace.getByName(ref) as ContextNodeStub;
}

/**
 * Dial a CODE context — a loopback entrypoint answering the context protocol
 * (`PlatformContext`, `AgentDefaultsContext`), recorded as a parent address
 * in a creation event. Props baked into the address win; `projectId` rides
 * along as the default every code context needs.
 */
export function dialCodeContext(input: {
  address: CapabilityAddress;
  exports: Record<string, (options: { props: Record<string, unknown> }) => unknown>;
  projectId: string;
}): import("./itx.ts").ItxStub {
  const address = input.address;
  if (address.worker.type !== "loopback" || !address.entrypoint) {
    throw new Error("A code-context address must be a loopback ref with an entrypoint.");
  }
  const factory = input.exports[address.entrypoint];
  if (typeof factory !== "function") {
    throw new Error(`Code-context loopback export ${address.entrypoint} is not available.`);
  }
  return factory({
    props: { projectId: input.projectId, ...address.props },
  }) as import("./itx.ts").ItxStub;
}

// ---- the context's stream --------------------------------------------------------

/** The context's stream as the core consumes it: append + read. */
export function contextStream(env: Env, coordinate: ItxCoordinate): ContextStream {
  const stub = () =>
    getInitializedStreamStub({
      durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: coordinate.namespace,
      path: StreamPath.parse(coordinate.path),
    });
  return {
    async append(event) {
      return await (await stub()).append(event);
    },
    async read(input) {
      return await (
        await stub()
      ).history({ after: input.afterOffset === 0 ? "start" : input.afterOffset });
    },
  };
}

// ---- creation -------------------------------------------------------------------

/** The default path for an anonymous extend — a convention, not a reserved
 * segment. The generated tail keeps sibling extends collision-free. */
export function generatedContextPath(typeIdPrefix: string): string {
  return `/itx/${typeid({ env: { TYPEID_PREFIX: typeIdPrefix }, prefix: "itx" })}`;
}

/**
 * Creation is two idempotent appends by the CREATOR (see the module doc):
 * the subscription that makes the stream push to the node, then the birth
 * certificate. Nothing dials the new node — it materializes when the
 * subscription delivers (or on its first dispatch). Re-creating an existing
 * coordinate is inert: the fold takes the first birth certificate.
 */
export async function createContext(input: {
  env: Env;
  namespace: string;
  path: string;
  name?: string | null;
  /** The parent link recorded in the birth certificate — chain delegation
   * dials this address on every miss. */
  parent: { ref: string; address: CapabilityAddress };
}): Promise<{ ref: string; address: CapabilityAddress }> {
  const coordinate: ItxCoordinate = {
    namespace: input.namespace,
    path: StreamPath.parse(input.path),
  };
  const ref = formatContextRef(coordinate);
  const stream = await getInitializedStreamStub({
    durableObjectNamespace: input.env.STREAM as unknown as StreamDurableObjectNamespace,
    namespace: coordinate.namespace,
    path: StreamPath.parse(coordinate.path),
  });
  await stream.append({
    type: "events.iterate.com/stream/subscription-configured",
    idempotencyKey: `itx-subscription:${ref}`,
    payload: {
      subscriptionKey: `itx:${ref}`,
      subscriber: durableObjectProcessorSubscriber({
        bindingName: ITX_CONTEXT_BINDING,
        durableObjectName: ref,
        processorName: ItxContract.slug,
      }),
    },
  });
  await stream.append({
    type: ITX_EVENT_TYPES.contextCreated,
    idempotencyKey: `itx-context-created:${ref}`,
    payload: {
      name: input.name ?? null,
      parent: input.parent,
    },
  });
  return { address: contextAddress(ref), ref };
}
