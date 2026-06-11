// ContextDO: hosts one CHILD context (spec §3) — the durable container behind
// itx.extend(). An agent session, a REPL scratchpad, a notebook-to-be: each
// is one ContextDO instance with the same anatomy as the project context it
// hangs under (capability core + parent pointer + stream + live connections),
// just cheaper and more disposable.
//
// Capability resolution walks the chain child → project (→ global, when the
// global node exists): the core delegates a miss to `parentItx` per call
// (DECISIONS.md D2 — no name index until latency says otherwise). Shadowing
// is allowed and VISIBLE: describe() returns the merged chain with each
// entry's owner, child entries first.

import { DurableObject } from "cloudflare:workers";
import { StreamPath } from "@iterate-com/shared/streams/types";
import {
  contextAddressOf,
  dialContext,
  ITX_EVENT_TYPES,
  resolveDialableTargets,
  type CapabilityAddress,
  type Itx,
  type ItxStub,
} from "./itx.ts";
import { DurableItx, durableObjectFacetsHook, makeDial } from "./durable-itx.ts";
import { ITX_AUDIT_STREAM_PATH } from "./refs.ts";
import { parseConfig } from "~/config.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";

export type ContextDescriptor = {
  id: string;
  name: string | null;
  /** The parent context: its identity (a project id or another ctx_… id, for
   * audit) plus its ADDRESS — how chain delegation dials the parent node. */
  parent: { id: string; address: CapabilityAddress };
  /** The owning project — every child context lives under exactly one. */
  projectId: string;
};

export class ContextDO extends DurableObject<Env> {
  #itx: DurableItx | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS itx_context (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent TEXT NOT NULL,
      name TEXT,
      created_at_ms INTEGER NOT NULL
    )`);
  }

  /** Idempotent: extend() calls this once; later connects just read. */
  initialize(input: {
    id: string;
    name?: string;
    parent: { id: string; address: CapabilityAddress };
    projectId: string;
  }) {
    const cursor = this.ctx.storage.sql.exec(
      `INSERT INTO itx_context (id, project_id, parent, name, created_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      input.id,
      input.projectId,
      // The parent column holds the JSON {id, address} pair — the id for
      // audit/identity, the address for chain delegation's dial.
      JSON.stringify(input.parent),
      input.name ?? null,
      Date.now(),
    );
    // Only emit the fork event when a row was actually inserted — a re-init or
    // retry (ON CONFLICT DO NOTHING) must not append a duplicate audit event.
    if (cursor.rowsWritten > 0) {
      this.audit(ITX_EVENT_TYPES.contextForked, { id: input.id, parent: input.parent.id });
    }
    return this.descriptor();
  }

  descriptor(): ContextDescriptor {
    const row = this.ctx.storage.sql
      .exec<{ id: string; name: string | null; parent: string; project_id: string }>(
        `SELECT id, project_id, parent, name FROM itx_context LIMIT 1`,
      )
      .toArray()[0];
    if (!row)
      throw new Error("This itx context has not been initialized (extend a context first).");
    return {
      id: row.id,
      name: row.name,
      parent: parseParent(row.parent, row.id),
      projectId: row.project_id,
    };
  }

  /** This node's own address — the save() half of the SturdyRef story. */
  address(): CapabilityAddress {
    return contextAddressOf(this.descriptor().id);
  }

  /**
   * This child context's capability core. Its `parentItx` is a stub of the
   * parent NODE's core — re-dialed per call (Workers RPC stubs are
   * request-scoped in a DO, so a held stub would go stale), with each verb
   * pipelining through the node's itx() in one round trip. No constructor
   * defaults here, deliberately: a child's misses delegate up the real chain
   * to the parent node, which is where the platform defaults (and any
   * shadowing project rows) live.
   */
  itx(): Itx {
    if (this.#itx) return this.#itx;
    const descriptor = this.descriptor();
    const parentNode = () => dialContext(this.env, descriptor.parent.address);
    const parentItx: ItxStub = {
      describe: () => parentNode().itx().describe(),
      invoke: (input) => parentNode().itx().invoke(input),
      provideCapability: (input) => parentNode().itx().provideCapability(input),
      revokeCapability: (input) => parentNode().itx().revokeCapability(input),
    };
    this.#itx = new DurableItx({
      audit: (event) => this.audit(event.type, event.payload),
      contextId: descriptor.id,
      dial: makeDial({
        allowlists: resolveDialableTargets(parseConfig(this.env).itx),
        contextId: descriptor.id,
        env: this.env,
        exports: this.ctx.exports as unknown as Parameters<typeof makeDial>[0]["exports"],
        facets: durableObjectFacetsHook(this.ctx),
        loader: (this.env as { LOADER?: unknown }).LOADER as Parameters<
          typeof makeDial
        >[0]["loader"],
        projectId: descriptor.projectId,
      }),
      parentItx,
      sql: this.ctx.storage.sql,
    });
    return this.#itx;
  }

  /**
   * Child-context audit events land on the owning project's /itx stream with
   * the context id in the payload — one audit surface per project (D9).
   */
  private audit(type: string, payload: Record<string, unknown>) {
    const projectId = this.ctx.storage.sql
      .exec<{ project_id: string }>(`SELECT project_id FROM itx_context LIMIT 1`)
      .toArray()[0]?.project_id;
    if (!projectId) return;
    const contextId = this.descriptor().id;
    this.ctx.waitUntil(
      (async () => {
        const stream = await getInitializedStreamStub({
          durableObjectNamespace: this.env.STREAM as unknown as StreamDurableObjectNamespace,
          namespace: projectId,
          path: StreamPath.parse(ITX_AUDIT_STREAM_PATH),
        });
        await stream.append({ payload: { ...payload, context: contextId }, type });
      })().catch((error) => {
        console.error(`[itx] child-context audit append failed for ${contextId}:`, error);
      }),
    );
  }
}

/**
 * Parent pointers are stored as JSON { id, address } since the address
 * unification. Rows written BEFORE it hold a bare id string — there is no
 * migration on purpose (no-backcompat posture; contexts are erasable): fail
 * with a named error instead of a mystery JSON.parse throw.
 */
function parseParent(raw: string, contextId: string): ContextDescriptor["parent"] {
  try {
    const parsed = JSON.parse(raw) as ContextDescriptor["parent"];
    if (parsed && typeof parsed === "object" && parsed.address) return parsed;
  } catch {
    // fall through to the named error below
  }
  throw new Error(
    `Context ${contextId} predates the address unification (parent ${JSON.stringify(raw)}); ` +
      `recreate it — pre-unification contexts are not migrated.`,
  );
}
