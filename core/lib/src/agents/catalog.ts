import { z } from "zod";
import {
  defineProcessorContract,
  StreamProcessor,
  type ConsumedEvent,
  type ReduceArgs,
  type ProcessorState,
} from "../stream/processor.ts";
import { StreamProcessorDurableObject } from "../sdk/index.ts";
import type { AgentHandleApi, AgentsApi } from "./api.ts";
import { AgentContract } from "./contract.ts";
import { AgentCollectionRpcTarget } from "./collection.ts";

const AgentCatalogContract = defineProcessorContract({
  slug: "agents",
  // 3: a certificate counts only when stamped with the path of the agent it names.
  version: "3",
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
export class AgentCatalogProcessor extends StreamProcessor<
  AgentCatalogState,
  ConsumedEvent<typeof AgentCatalogContract>
> {
  readonly contract = AgentCatalogContract;
  /** A certificate counts only from the agent it names: each agent writes its own on `/`
   *  (processor.ts), and the platform stamps where it came from (core/os caller.ts `stampCaller`),
   *  so one any other context appends is ignored — anyone may append anywhere, and a forged death
   *  would refuse the agent's every message for good. */
  reduce({
    state,
    event,
  }: ReduceArgs<AgentCatalogState, ConsumedEvent<typeof AgentCatalogContract>>) {
    const path = event.payload.path;
    if (event.source.origin !== path) return;
    if (event.type === "events.iterate.com/agent/created") {
      if (state.agents[path] || state.deleted[path]) return; // born once; dead is terminal
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
  static override publicMethods = [...super.publicMethods, "list", "get", "create", "delete", "at"];

  processor = new AgentCatalogProcessor();
  at(base: string) {
    return new AgentCollectionRpcTarget(
      () => this.getItx(),
      // THROUGH THE LOG'S HEAD, not the last pushed batch (`snapshot()` alone answers from what the
      // delivery loop has pushed so far): a death is on `/` before `delete()` returns — the saga
      // posts it here before its own certificate — so a verb on the dead agent right after must see
      // it, or it would host the facet again (collection.ts).
      async () => {
        await this.catchUpFromLog();
        return (await this.snapshot()).state;
      },
      base,
    );
  }
  #collection = this.at("/");
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
