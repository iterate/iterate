// The coordinate system: identity is a stream coordinate (itx-next.md,
// "LOCKED: the final shape").
//
// Every context's journal is an ordinary event stream at
// `<host base>/itx[/<child-id>]` in the owning project's namespace:
//
//   project context              (prj_x, "/itx")           — own journal, base "/"
//   extend the project           (prj_x, "/itx/itx_a")     — child under the base
//   an agent's context           (prj_x, "<agentPath>/itx/itx_b")
//
// "itx" is a RESERVED stream path segment: domain code (subagent paths, user
// streams) may not write under it — assertStreamPathDoesNotClaimItxSegment
// is the one clear error, applied at the user-facing append doors. Journals
// remain ordinary readable streams (the streams browser shows them).
//
// The generic context DO's NAME encodes the coordinate verbatim
// (`<namespace>:<journalPath>`, the same shape stream DO names use), so
// identity, journal ref, and self-address are PROJECTIONS of the name —
// derived, never configured. Bare `itx_…` refs (reconnects, isolate props)
// resolve through the D1 catalog row extendContext writes — a directory in
// D1's sanctioned role, never the authority: parentage and state fold from
// the journal.

import type { Client } from "sqlfu";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { typeid } from "@iterate-com/shared/typeid";
import { ITX_EVENT_TYPES, type CapabilityAddress, type ItxJournal } from "./itx.ts";
import { isChildContextId } from "./refs.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";
import { getItxContextById, insertItxContext } from "~/db/queries/.generated/index.ts";

/** The reserved stream path segment context journals live under. */
export const ITX_JOURNAL_SEGMENT = "itx";

/** Where one context's journal lives: an ordinary stream coordinate. */
export type ItxJournalRef = { namespace: string; path: string };

/** Does this path claim the reserved `itx` segment anywhere? */
export function streamPathClaimsItxSegment(path: string): boolean {
  return path.split("/").includes(ITX_JOURNAL_SEGMENT);
}

/** The one clear error for domain/user writes under the reserved segment. */
export function assertStreamPathDoesNotClaimItxSegment(path: string): void {
  if (streamPathClaimsItxSegment(path)) {
    throw new Error(
      `The "${ITX_JOURNAL_SEGMENT}" stream path segment is reserved for context journals ` +
        `(${JSON.stringify(path)}) — domain and user streams may not write under it.`,
    );
  }
}

/** A host's OWN context journal: `<base>/itx` (uniform — the project's is
 * "/itx"; an agent's would be "<agentPath>/itx"). */
export function ownJournalPath(base: string): string {
  return joinStreamPath(base, ITX_JOURNAL_SEGMENT);
}

/** A CHILD context's journal: `<base>/itx/<child-id>`. */
export function childJournalPath(base: string, contextId: string): string {
  return joinStreamPath(base, `${ITX_JOURNAL_SEGMENT}/${contextId}`);
}

function joinStreamPath(base: string, suffix: string): string {
  const trimmed = base === "/" ? "" : base.replace(/\/$/, "");
  return StreamPath.parse(`${trimmed}/${suffix}`);
}

/** The journal base a child extended from this journal inherits: the journal
 * path with its own `/itx[/<id>]` tail removed. */
export function journalBaseOf(journalPath: string): string {
  const segments = journalPath.split("/").filter(Boolean);
  const index = segments.lastIndexOf(ITX_JOURNAL_SEGMENT);
  const base = segments.slice(0, index === -1 ? segments.length : index).join("/");
  return base === "" ? "/" : `/${base}`;
}

/** A child context's id is the last segment of its journal path. */
export function contextIdOfJournalPath(journalPath: string): string {
  const last = journalPath.split("/").filter(Boolean).at(-1);
  if (!last) throw new Error(`Journal path ${JSON.stringify(journalPath)} has no context id.`);
  return last;
}

// ---- addresses ------------------------------------------------------------------
//
// A context's ADDRESS is a CapabilityAddress — "how to dial the node that
// owns this identity". Identity (the string id) stays identity; this is the
// id→address seam, and the only place the hosting bindings are named.

const ITX_CONTEXT_BINDING = "ITX_CONTEXT";
const PROJECT_CONTEXT_BINDING = "PROJECT";

/** The Project DO hosts the project context, addressed by the project id. */
export function projectContextAddress(projectId: string): CapabilityAddress {
  return {
    type: "rpc",
    worker: { binding: PROJECT_CONTEXT_BINDING, name: projectId, type: "durable-object" },
  };
}

/** The generic host (ItxDurableObject) is addressed by the journal
 * coordinate itself — the save() half of the SturdyRef story. */
export function childContextAddress(journal: ItxJournalRef): CapabilityAddress {
  return {
    type: "rpc",
    worker: {
      binding: ITX_CONTEXT_BINDING,
      name: itxDurableObjectName(journal),
      type: "durable-object",
    },
  };
}

export function itxDurableObjectName(journal: ItxJournalRef): string {
  return `${journal.namespace}:${journal.path}`;
}

export function parseItxDurableObjectName(name: string): ItxJournalRef {
  const colon = name.indexOf(":");
  if (colon <= 0 || name[colon + 1] !== "/") {
    throw new Error(
      `ItxDurableObject must be addressed by its journal coordinate ("<namespace>:/<path>"), got ${JSON.stringify(name)}.`,
    );
  }
  return { namespace: name.slice(0, colon), path: name.slice(colon + 1) };
}

/** Does this address dial a generic context host (an ItxDurableObject)?
 * Keyed off the structured address, never an id prefix. */
export function isChildContextAddress(address: CapabilityAddress): boolean {
  return (
    address.type === "rpc" &&
    address.worker.type === "durable-object" &&
    address.worker.binding === ITX_CONTEXT_BINDING
  );
}

/** What a dialed context NODE answers: its core (the itx() method — a
 * method, not a property, so `node.itx().invoke(...)` pipelines in one
 * round trip), plus, on generic hosts only, the descriptor derived from the
 * journal fold. Gate on {@link isChildContextAddress} before descriptor. */
export type ContextNodeStub = {
  itx(): import("./itx.ts").ItxStub;
  descriptor?(): Promise<ContextDescriptor>;
};

export type ContextDescriptor = {
  id: string;
  name: string | null;
  /** The parent context: its identity plus its ADDRESS — how chain
   * delegation and itx.super dial the parent node. */
  parent: { id: string; address: CapabilityAddress };
  /** The owning project — every child context lives under exactly one. */
  projectId: string;
};

/**
 * The restore() half: resolve an address to a live context-node stub. This
 * dial is KERNEL plumbing for addresses written by trusted code (extend, the
 * restorer, birth certificates) — it is deliberately NOT gated by the
 * dialable allowlists: provider-supplied cap addresses stay gated inside the
 * capability dial; context addresses are written only by kernel code.
 */
export function dialContext(env: Env, address: CapabilityAddress): ContextNodeStub {
  if (address.type === "url") {
    throw new Error(
      "url context addresses are not dialable yet (cross-deployment federation is a recorded direction, not built).",
    );
  }
  const worker = address.worker;
  if (worker.type !== "durable-object") {
    throw new Error(`"${worker.type}" worker refs cannot address a context node.`);
  }
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

// ---- the journal stream ----------------------------------------------------------

/** The journal as the core consumes it: append + read on ONE stream. This is
 * the internal door — it may write under the reserved `itx` segment. */
export function journalStream(env: Env, journal: ItxJournalRef): ItxJournal {
  const stub = () =>
    getInitializedStreamStub({
      durableObjectNamespace: env.STREAM as unknown as StreamDurableObjectNamespace,
      namespace: journal.namespace,
      path: StreamPath.parse(journal.path),
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

export type ExtendedContext = {
  contextId: string;
  journal: ItxJournalRef;
  address: CapabilityAddress;
};

/**
 * Creation is an event (docs/domain-objects-and-stream-processors.md):
 * mint the id, append `context-created` — the journal's birth certificate,
 * carrying parentage — and return. Nothing touches the new context node:
 * it materializes lazily by consuming its journal on first dispatch. The
 * catalog row is a directory entry (bare-id restores), never the authority.
 */
export async function extendContext(input: {
  env: Env;
  db: Client;
  typeIdPrefix: string;
  projectId: string;
  /** The parent context — its id and address land in the birth certificate. */
  parent: { id: string; address: CapabilityAddress };
  /** The HOST base the child's journal nests under ("/" for project
   * children; an agent's context passes its agentPath). */
  base: string;
  name?: string;
}): Promise<ExtendedContext> {
  const contextId = typeid({
    env: { TYPEID_PREFIX: input.typeIdPrefix },
    prefix: "itx",
  });
  const journal: ItxJournalRef = {
    namespace: input.projectId,
    path: childJournalPath(input.base, contextId),
  };
  await journalStream(input.env, journal).append({
    payload: {
      id: contextId,
      name: input.name ?? null,
      parent: input.parent,
    },
    type: ITX_EVENT_TYPES.contextCreated,
  });
  await insertItxContext(input.db, {
    id: contextId,
    journalPath: journal.path,
    projectId: input.projectId,
  });
  return { address: childContextAddress(journal), contextId, journal };
}

/** Resolve a bare `itx_…` ref through the catalog. */
export async function lookupContext(
  db: Client,
  contextId: string,
): Promise<{ projectId: string; journal: ItxJournalRef; address: CapabilityAddress } | null> {
  if (!isChildContextId(contextId)) return null;
  const row = await getItxContextById(db, { id: contextId });
  if (!row) return null;
  const journal: ItxJournalRef = { namespace: row.project_id, path: row.journal_path };
  return { address: childContextAddress(journal), journal, projectId: row.project_id };
}
