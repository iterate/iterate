// src/agent/collection.ts — `itx.agents`: THE AGENT COLLECTION, a member of the project facet on `/`
// (src/project/durable-object.ts), where the catalog lives. `list()` reads the catalog; `create(path)`
// is THE CREATION — the processor row on the path, the request, then the terminal fact. Addressing an
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
   *  `agent/create-requested`, then the terminal fact — `agent/created` (in the catalog by then, the
   *  default system prompt beside it on the path), or `agent/create-failed`, thrown; a later call is
   *  a new attempt. Idempotent: a created agent answers at once. Data back, never the handle:
   *  `itx.agents.get(path)` addresses it. An operator's instructions are their own append after:
   *  `itx.agents.get(path).append({ type: "events.iterate.com/agent/context-added", … })`. */
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
      ])) as {
        state: AgentState;
      };
      if (state.creation?.status === "created") return { path };
      await context.processors.enable("agent");
      // Over the loopback stub an append's answer types as an RPC result, not the array the context
      // declares (`append(...events): Promise<StreamEvent[]>`); the wire copied it.
      const [requested] = (await context.append({
        type: "events.iterate.com/agent/create-requested",
        payload: {},
      })) as unknown as StreamEvent[];
      const settled = (await context.waitForEvent({
        type: ["events.iterate.com/agent/created", "events.iterate.com/agent/create-failed"],
        afterOffset: requested!.offset,
      })) as unknown as StreamEvent;
      if (settled.type === "events.iterate.com/agent/create-failed")
        throw new Error(`agent ${path}: creation failed — ${String(settled.payload?.error)}`);
      return { path };
    });
  }
}
