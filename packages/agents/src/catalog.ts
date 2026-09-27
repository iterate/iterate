import { z } from "zod";
import {
  defineProcessorContract,
  StreamProcessor,
  type ConsumedEvent,
  type ReduceArgs,
  type ProcessorState,
} from "iterate/stream/processor";
import { StreamProcessorDurableObject } from "iterate/sdk";
import type { AgentHandleApi, AgentsApi } from "./api.ts";
import { AgentContract } from "./contract.ts";
import { AgentCollectionRpcTarget } from "./collection.ts";

const AgentCatalogContract = defineProcessorContract({
  slug: "agents",
  // 2: the deleted agents are kept (`deleted`), so a verb on one refuses from here without hosting
  // its facet again (collection.ts).
  version: "2",
  description: "The agents installed in this project by the userspace agents app.",
  stateSchema: z.object({
    agents: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
    /** Every agent that died, by path: its death certificate. Terminal — a deleted agent is not
     *  re-creatable — so a verb on one answers from this row and never hosts the agent's facet on
     *  its context again (collection.ts says why that matters). */
    deleted: z.record(z.string(), z.object({ deletedAt: z.string() })).default({}),
  }),
  events: {},
  processorDeps: [AgentContract],
  consumes: ["events.iterate.com/agent/created", "events.iterate.com/agent/deleted"],
  emits: [],
});
export type AgentCatalogState = ProcessorState<typeof AgentCatalogContract>;
class AgentCatalogProcessor extends StreamProcessor<
  AgentCatalogState,
  ConsumedEvent<typeof AgentCatalogContract>
> {
  readonly contract = AgentCatalogContract;
  /** A certificate counts only from the agent it names: each agent writes its own on `/`
   *  (processor.ts), and the platform stamps where it came from (apps/os caller.ts `stampCaller`),
   *  so one any other context appends is ignored — anyone may append anywhere, and a forged death
   *  would refuse the agent's every message for good. One with no origin predates the stamp. */
  reduce({
    state,
    event,
  }: ReduceArgs<AgentCatalogState, ConsumedEvent<typeof AgentCatalogContract>>) {
    const path = event.payload.path;
    if (event.source?.origin && event.source.origin !== path) return;
    if (event.type === "events.iterate.com/agent/created") {
      if (state.agents[path]) return;
      return { ...state, agents: { ...state.agents, [path]: { createdAt: event.createdAt } } };
    }
    if (state.deleted[path]) return;
    const { [path]: _deleted, ...agents } = state.agents;
    return {
      ...state,
      agents,
      deleted: { ...state.deleted, [path]: { deletedAt: event.createdAt } },
    };
  }
}

/** The agents app's collection facet — what the `itx.agents` rule names (install.ts): the
 *  published `AgentsApi` (api.ts) at the project's root, plus `at(base)`, the collection an agent's
 *  own `itx.agents` rule reaches. */
export class AgentCollectionDurableObject
  extends StreamProcessorDurableObject<AgentCatalogState>
  implements AgentsApi
{
  /** The processor's reads, and `itx.agents`: the collection's verbs and `at(base)` (collection.ts). */
  static override publicMethods = [
    ...super.publicMethods,
    "list",
    "get",
    "create",
    "delete",
    "upgrade",
    "at",
  ];

  processor = new AgentCatalogProcessor();
  at(base: string) {
    return new AgentCollectionRpcTarget(
      (call) => this.withItx(call),
      // THROUGH THE LOG'S HEAD, not the last pushed batch (`snapshot()` alone answers from what the
      // delivery loop has pushed so far): a death is on `/` before `delete()` returns — the saga
      // posts it here before its own certificate — so a verb on the dead agent right after must see
      // it, or it would host the facet again (collection.ts).
      async () => {
        await this.catchUpFromLog();
        return (await this.snapshot()).state;
      },
      async () => {
        const runtime = await this.withItx((itx) => itx.kv.get("agents/runtime"));
        if (!runtime) throw new Error("The agents runtime has not been installed");
        // Written by install.ts: the runtime's files and its content hash.
        const { cacheKey, source } = JSON.parse(runtime) as {
          cacheKey: string;
          source: Record<string, string>;
        };
        return { cacheKey, source, className: "AgentDurableObject" };
      },
      base,
    );
  }
  #collection = this.at("/");
  upgrade() {
    return this.#collection.upgrade();
  }
  list() {
    return this.#collection.list();
  }
  // oxlint-disable-next-line iterate/mechanical-class-impl -- the published declarations name the handle by its interface: the inferred class is collection.ts's own
  get(path: string): AgentHandleApi {
    return this.#collection.get(path);
  }
  create(path: string) {
    return this.#collection.create(path);
  }
  delete(path: string) {
    return this.#collection.delete(path);
  }
}
