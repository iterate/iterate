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

const Certificate = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("events.iterate.com/agent/created"),
    payload: z.object({ path: z.string().startsWith("/").min(2) }),
  }),
  z.object({
    type: z.literal("events.iterate.com/agent/deleted"),
    payload: z.object({ path: z.string().startsWith("/").min(2) }),
  }),
]);

/** The agents app's collection facet — what the `itx.agents` rule names (install.ts): the
 *  published `AgentsApi` (api.ts) at the project's root, plus `at(base)` and `announce`, the
 *  app's own plumbing between an agent's context and the root. */
export class AgentCollectionDurableObject
  extends StreamProcessorDurableObject<AgentCatalogState>
  implements AgentsApi
{
  /** The processor's reads, and `itx.agents`: the collection's verbs, `at(base)` (the collection an
   *  agent's own `itx.agents` rule reaches, collection.ts) and `announce` (a certificate from an
   *  agent context). */
  static override publicMethods = [
    ...super.publicMethods,
    "list",
    "get",
    "create",
    "delete",
    "upgrade",
    "at",
    "announce",
  ];

  processor = new AgentCatalogProcessor();
  at(base: string) {
    return new AgentCollectionRpcTarget(
      (call) => this.withItx(call),
      // THROUGH THE LOG'S HEAD, not the last pushed batch (`snapshot()` alone answers from what the
      // delivery loop has pushed so far): a death is on `/` before `delete()` returns — the saga
      // announces it before its own certificate — so a verb on the dead agent right after must see
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
  async announce(input: unknown) {
    const event = Certificate.parse(input);
    await this.withItx((itx) =>
      itx.append({ ...event, idempotencyKey: `${event.type}:${event.payload.path}` }),
    );
  }
}
