import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import { defineProcessorContract } from "iterate/processors";
import type { AgentProcessorDeps } from "./agent-host.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";

/**
 * RETIRED-SLUG STUB. "agent-headless" was a second registered agent
 * processor (same vocabulary, no response interpretation) selected per
 * stream by the retired `config.driver` knob. Response interpretation is
 * now a config flag on the ONE agent processor
 * (`enableDefaultLlmResponseParsing` — agent-processor-contract.ts), and
 * every agent stream carries the "agent" subscription from birth, so the
 * unified processor already drives every stream this one used to.
 *
 * The slug stays registered because hosted-processor subscriptions cannot
 * be removed: streams that opted into the headless handover still carry an
 * "agent-headless" subscription, and an unregistered name would fail those
 * deliveries loudly. This stub accepts them and does nothing. Delete once
 * no live stream carries the subscription.
 */
export const HeadlessAgentProcessorContract = defineProcessorContract({
  slug: "agent-headless",
  version: AgentProcessorContract.version,
  description:
    "Retired alias of the agent processor's headless mode — accepts deliveries for streams " +
    "still subscribed under this name and does nothing; the unified agent processor (their " +
    '"agent" subscription) drives them, with parsing controlled by ' +
    "config.enableDefaultLlmResponseParsing.",
  stateSchema: AgentProcessorContract.stateSchema,
  processorDeps: AgentProcessorContract.processorDeps,
  events: AgentProcessorContract.events,
  consumes: AgentProcessorContract.consumes,
  emits: AgentProcessorContract.emits,
});

export type HeadlessAgentProcessorContract = typeof HeadlessAgentProcessorContract;

export class HeadlessAgentProcessor extends StreamProcessor<
  HeadlessAgentProcessorContract,
  AgentProcessorDeps
> {
  readonly contract = HeadlessAgentProcessorContract;

  protected override processEvent(
    _args: ProcessEventArgs<HeadlessAgentProcessorContract>,
  ): undefined {}

  protected override reduce({ state }: ReduceArgs<HeadlessAgentProcessorContract>) {
    return state;
  }
}
