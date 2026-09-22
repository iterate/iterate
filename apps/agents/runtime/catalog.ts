import { z } from "zod";
import {
  defineProcessorContract,
  StreamProcessor,
  type ConsumedEvent,
  type ReduceArgs,
  type ProcessorState,
} from "iterate/next/stream/processor";
import { StreamProcessorDurableObject } from "iterate/next/sdk";
import { AgentContract } from "./contract.ts";
import { AgentCollectionRpcTarget } from "./collection.ts";

export const AgentCatalogContract = defineProcessorContract({
  slug: "agents",
  version: "1",
  description: "The agents installed in this project by the userspace agents app.",
  stateSchema: z.object({
    agents: z.record(z.string(), z.object({ createdAt: z.string() })).default({}),
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
  reduce({
    state,
    event,
  }: ReduceArgs<AgentCatalogState, ConsumedEvent<typeof AgentCatalogContract>>) {
    const path = event.payload.path;
    if (event.type === "events.iterate.com/agent/created") {
      if (state.agents[path]) return;
      return { ...state, agents: { ...state.agents, [path]: { createdAt: event.createdAt } } };
    }
    if (!state.agents[path]) return;
    const { [path]: _deleted, ...agents } = state.agents;
    return { ...state, agents };
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

export class AgentCollectionDurableObject extends StreamProcessorDurableObject<AgentCatalogState> {
  processor = new AgentCatalogProcessor();
  at(base: string) {
    return new AgentCollectionRpcTarget(
      (call) => this.withItx(call),
      async () => (await this.snapshot()).state,
      async () => {
        const cacheKey = await this.withItx((itx) => itx.kv.get("agents/runtime-key"));
        if (!cacheKey) throw new Error("The agents runtime has not been installed");
        const source = await this.withItx((itx) => itx.kv.get(`agents/runtime/${cacheKey}.js`));
        if (!source) throw new Error(`The installed agents runtime is missing: ${cacheKey}`);
        return { cacheKey, source: { "cap.js": source }, className: "AgentDurableObject" };
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
  get(path: string) {
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
