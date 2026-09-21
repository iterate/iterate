// src/agent/collection.ts — `itx.agents`: THE AGENT COLLECTION, a member of the project facet on `/`
// (src/project/durable-object.ts), where the catalog lives. `list()` reads the catalog; `create(path)`
// is THE CREATION — the processor row on the path, the request, then the terminal fact; `delete(path)`
// is THE DELETION, its mirror — the request, the death certificate, then the row goes. Addressing an
// agent (`itx.agents.get(path)`) is the library's (library.ts): straight to the path, never through `/`.
import { RpcTarget } from "cloudflare:workers";
import type { WithItx } from "iterate/next/sdk";
import type { StreamEvent } from "iterate/next/stream/processor";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { ProjectState } from "../project/contract.ts";
import type { AgentState } from "./contract.ts";

export class AgentCollectionRpcTarget extends RpcTarget {
  constructor(
    private readonly withItx: WithItx<ItxEntrypointScope>,
    private readonly catalog: () => Promise<ProjectState>,
  ) {
    super();
  }

  /** Every agent born under the project, by path — the certificates cross-posted to `/`, folded. */
  async list(): Promise<{ path: string; createdAt: string }[]> {
    return Object.entries((await this.catalog()).agents).map(([path, row]) => ({ path, ...row }));
  }

  /** Bring the agent at `path` into being: the `agent` processor row on that path, then
   *  `agent/create-requested`, then the terminal fact — `agent/created` (in the catalog by then), or
   *  `agent/create-failed`, thrown; a later call is a new attempt. Idempotent: a created agent answers
   *  at once, and a creation already open is WAITED ON, never requested again — the terminal is
   *  sought after the request that opened it, so a certificate landing between the read and the
   *  wait is seen, not missed. A deleted agent is not re-creatable: thrown. Data back, never the
   *  handle: `itx.agents.get(path)` addresses it. */
  create(path: string): Promise<{ path: string }> {
    return this.withItx(async (itx) => {
      const context = itx.cd(path);
      // The facet is the platform's own AgentDurableObject and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      const { state } = (await context.invoke([
        "itx",
        "facets",
        ["get", "agent"],
        ["snapshot"],
      ])) as { state: AgentState };
      if (state.deletion) throw new Error(`agent ${path}: deleted — not re-creatable`);
      if (state.creation?.status === "created") return { path };
      let requestedAtOffset: number;
      if (state.creation?.status === "requested") requestedAtOffset = state.creation.offset;
      else {
        await context.processors.enable("agent");
        // Over the loopback stub an append's answer types as an RPC result, not the array the context
        // declares (`append(...events): Promise<StreamEvent[]>`); the wire copied it.
        const [requested] = (await context.append({
          type: "events.iterate.com/agent/create-requested",
          payload: {},
        })) as unknown as StreamEvent[];
        requestedAtOffset = requested!.offset;
      }
      const settled = (await context.waitForEvent({
        type: ["events.iterate.com/agent/created", "events.iterate.com/agent/create-failed"],
        afterOffset: requestedAtOffset,
      })) as unknown as StreamEvent;
      if (settled.type === "events.iterate.com/agent/create-failed")
        throw new Error(`agent ${path}: creation failed — ${String(settled.payload?.error)}`);
      return { path };
    });
  }

  /** Take the agent at `path` out of being: `agent/delete-requested` on that path, then the death
   *  certificate — `agent/deleted` (gone from the catalog by then; the loop runs no more turns) —
   *  then the `agent` processor row goes, and the facet with it, storage included. Idempotent: a
   *  deleted agent answers at once, and a deletion already open is WAITED ON, never requested again
   *  — the certificate is sought after the request that opened it, so one landing between the read
   *  and the wait is seen, not missed. An agent never created has nothing to delete: thrown.
   *  Terminal: a deleted agent is not re-creatable. */
  delete(path: string): Promise<{ path: string }> {
    return this.withItx(async (itx) => {
      const context = itx.cd(path);
      // The facet is the platform's own AgentDurableObject and `snapshot()` the engine's
      // `{ offset, state }`, its state the contract's parsed shape — ours, so asserted, not re-validated.
      const { state } = (await context.invoke([
        "itx",
        "facets",
        ["get", "agent"],
        ["snapshot"],
      ])) as { state: AgentState };
      if (state.deletion?.status === "deleted") return { path };
      if (state.creation?.status !== "created")
        throw new Error(`agent ${path}: not created — nothing to delete`);
      let requestedAtOffset: number;
      if (state.deletion?.status === "requested") requestedAtOffset = state.deletion.offset;
      else {
        // Over the loopback stub an append's answer types as an RPC result, not the array the context
        // declares (`append(...events): Promise<StreamEvent[]>`); the wire copied it.
        const [requested] = (await context.append({
          type: "events.iterate.com/agent/delete-requested",
          payload: {},
        })) as unknown as StreamEvent[];
        requestedAtOffset = requested!.offset;
      }
      await context.waitForEvent({
        type: "events.iterate.com/agent/deleted",
        afterOffset: requestedAtOffset,
      });
      await context.processors.disable("agent"); // the row, and the facet's storage, go
      return { path };
    });
  }
}
