// ContextDO: hosts one CHILD context (spec §3) — the durable container behind
// itx.fork(). An agent session, a REPL scratchpad, a notebook-to-be: each is
// one ContextDO instance with the same anatomy as the project context it
// hangs under (registry + parent pointer + stream + live connections), just
// cheaper and more disposable.
//
// Capability resolution walks the chain child → project (→ global, when the
// global registry exists): a miss here delegates to the parent per call
// (DECISIONS.md D2 — no name index until latency says otherwise). Shadowing
// is allowed and VISIBLE: itxDescribe() returns the merged chain with each
// entry's owner, child entries first.

import { DurableObject } from "cloudflare:workers";
import { StreamPath } from "@iterate-com/shared/streams/types";
import { ContextRegistry, type LiveCapTarget } from "./registry.ts";
import { createContextRegistryHost } from "./registry-host.ts";
import { ITX_AUDIT_STREAM_PATH, ITX_EVENT_TYPES } from "./protocol.ts";
import type {
  CapDescription,
  CapInvoke,
  CapMeta,
  PathCall,
  SerializableCapTarget,
} from "./protocol.ts";
import {
  contextAddressOf,
  dialContext,
  type ContextAddress,
  type ContextNodeStub,
} from "./addresses.ts";
import {
  getInitializedStreamStub,
  type StreamDurableObjectNamespace,
} from "~/domains/streams/stream-runtime.ts";

export type ContextDescriptor = {
  id: string;
  name: string | null;
  /** The parent context: its identity (a project id or another ctx_… id, for
   * audit) plus its ADDRESS — how chain delegation dials the parent node. */
  parent: { id: string; address: ContextAddress };
  /** The owning project — every child context lives under exactly one. */
  projectId: string;
};

export class ContextDO extends DurableObject<Env> {
  #registry: ContextRegistry | null = null;

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

  /** Idempotent: fork() calls this once; later connects just read. */
  initialize(input: {
    id: string;
    name?: string;
    parent: { id: string; address: ContextAddress };
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
    if (!row) throw new Error("This itx context has not been initialized (fork it first).");
    return {
      id: row.id,
      name: row.name,
      parent: JSON.parse(row.parent) as ContextDescriptor["parent"],
      projectId: row.project_id,
    };
  }

  /** This node's own address — the save() half of the SturdyRef story. */
  address(): ContextAddress {
    return contextAddressOf(this.descriptor().id);
  }

  itxDefine(input: {
    name?: string;
    path?: string[];
    target: SerializableCapTarget | LiveCapTarget;
    invoke?: CapInvoke;
    meta?: CapMeta;
  }) {
    return this.registry().define(input);
  }

  itxRevoke(input: { name?: string; path?: string[] }) {
    return this.registry().revoke(input);
  }

  /** Merged chain view: own caps first, then parents', shadowed names marked. */
  async itxDescribe(): Promise<CapDescription[]> {
    const own = this.registry().describe();
    const ownNames = new Set(own.map((cap) => cap.name));
    const parentCaps = await this.parentStub().itxDescribe();
    return [...own, ...parentCaps.filter((cap) => !ownNames.has(cap.name))];
  }

  async itxInvoke(input: PathCall & { origin?: string }): Promise<unknown> {
    const registry = this.registry();
    if (registry.resolves(input.path)) {
      return await registry.invoke({ args: input.args, path: input.path }, input.origin);
    }
    // Chain delegation: the WHOLE call path moves up, one extra hop per
    // parent level, no cache to invalidate. The ORIGIN context rides along so
    // context-scoped caps resolved at an ancestor still bind to the caller's
    // context.
    return await this.parentStub().itxInvoke({
      ...input,
      origin: input.origin ?? this.descriptor().id,
    });
  }

  private parentStub(): ContextNodeStub {
    return dialContext(this.env, this.descriptor().parent.address);
  }

  private registry(): ContextRegistry {
    if (this.#registry) return this.#registry;
    const descriptor = this.descriptor();
    this.#registry = new ContextRegistry(
      // No `defaults` here, deliberately: a child context's misses delegate
      // up the real chain (itxInvoke below) to the parent node, which is
      // where the platform:project code-context link lives.
      createContextRegistryHost({
        audit: (event) => this.audit(event.type, event.payload),
        contextId: descriptor.id,
        ctx: this.ctx,
        env: this.env,
        projectId: descriptor.projectId,
      }),
    );
    return this.#registry;
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
