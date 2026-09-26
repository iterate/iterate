import { z } from "zod";
import {
  certifiesItself,
  defineProcessorContract,
  StreamProcessor,
  trusts,
  type ConsumedEvent,
  type ReduceArgs,
  type ProcessorState,
  type TrustRule,
} from "iterate/stream/processor";
import type { FacetSpec } from "iterate/api";
import {
  StreamProcessorDurableObject,
  withItx,
  type ItxCaller,
  type ItxScope,
  type WithItx,
} from "iterate/sdk";
import type { AgentHandleApi, AgentsApi } from "./api.ts";
import { AgentContract } from "./contract.ts";
import { AgentCollectionRpcTarget } from "./collection.ts";

/** An agent's birth or death as the catalog hears it: from the agent itself, or from the trusted. */
const certifiedOrTrusted: TrustRule = (source, event) =>
  certifiesItself(source, event) || trusts(event.path, source);

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
  // WHOM IT LISTENS TO: an agent's own certificate (it names its own path, and the platform stamped
  // that path as its writer), or the trusted — the platform, a member, code at `/`.
  trust: {
    "events.iterate.com/agent/created": certifiedOrTrusted,
    "events.iterate.com/agent/deleted": certifiedOrTrusted,
  },
});
export type AgentCatalogState = ProcessorState<typeof AgentCatalogContract>;
class AgentCatalogProcessor extends StreamProcessor<
  AgentCatalogState,
  ConsumedEvent<typeof AgentCatalogContract>
> {
  readonly contract = AgentCatalogContract;
  reduce({
    state,
    event,
  }: ReduceArgs<AgentCatalogState, ConsumedEvent<typeof AgentCatalogContract>>) {
    const path = event.payload.path;
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
 *  published `AgentsApi` (api.ts) at the project's root, served to a caller beneath the root through
 *  `forCaller`, as that caller (collection.ts). Its catalog is a directory: an agent's own
 *  certificate enrolls it, and enrolling grants nothing. */
export class AgentCollectionDurableObject
  extends StreamProcessorDurableObject<AgentCatalogState>
  implements AgentsApi
{
  /** The processor's reads, `itx.agents`'s verbs, and `forCaller`, which the platform calls for a
   *  caller beneath the root (apps/os context/caller-capability.ts). */
  static override publicMethods = [
    ...super.publicMethods,
    "list",
    "get",
    "create",
    "delete",
    "upgrade",
    "forCaller",
  ];

  processor = new AgentCatalogProcessor();

  /** A caller beneath the root: the collection acting through that caller's own walled handle —
   *  its relative paths, its parent links, its appends. */
  forCaller(caller: ItxCaller) {
    return this.#collection((call) => withItx(caller.itx, call), caller.path);
  }

  #collection(itx: WithItx<ItxScope>, base: string) {
    return new AgentCollectionRpcTarget(
      itx,
      // THROUGH THE LOG'S HEAD, not the last pushed batch (`snapshot()` alone answers from what the
      // delivery loop has pushed so far): a death is on `/` before `delete()` returns — the saga
      // lands it before its own certificate — so a verb on the dead agent right after must see it,
      // or it would host the facet again (collection.ts).
      async () => {
        await this.catchUpFromLog();
        return (await this.snapshot()).state;
      },
      this.#runtime(),
      base,
    );
  }

  /** The agent runtime: this facet's own source (`ctx.props.spec`, its startup memo), the agents'
   *  class. Installing a new source rebinds the collection, and `upgrade()` every agent. */
  #runtime(): FacetSpec {
    const spec = this.ctx.props.spec;
    if (!spec) throw new Error("The agents collection is hosted from a source: install.ts");
    return { source: spec.source, cacheKey: spec.cacheKey, className: "AgentDurableObject" };
  }

  // A caller at the root, or above it, is served as the root.
  upgrade() {
    return this.#collection((call) => this.withItx(call), "/").upgrade();
  }
  list() {
    return this.#collection((call) => this.withItx(call), "/").list();
  }
  // oxlint-disable-next-line iterate/mechanical-class-impl -- the published declarations name the handle by its interface: the inferred class is collection.ts's own
  get(path: string): AgentHandleApi {
    return this.#collection((call) => this.withItx(call), "/").get(path);
  }
  create(path: string) {
    return this.#collection((call) => this.withItx(call), "/").create(path);
  }
  delete(path: string) {
    return this.#collection((call) => this.withItx(call), "/").delete(path);
  }
}
