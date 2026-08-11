import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import { defineProcessorContract } from "iterate/processors";
import type { AgentProcessorDeps } from "./agent-host.ts";
import { AgentLlmRequest } from "./agent-llm-request.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { agentComponentHost } from "./agent-processor-implementation.ts";
import { reduceAgentEvent } from "./agent-prompt-fold.ts";
import { AgentTurnLoop } from "./agent-turn-loop.ts";

/**
 * The HEADLESS agent contract: the agent contract verbatim — same state
 * schema, same event vocabulary, same consumes/emits — under its own slug so
 * the registry can route wakes to the headless class. The shared version
 * string is deliberate: the two contracts must never drift, they are one
 * vocabulary hosted two ways.
 */
export const HeadlessAgentProcessorContract = defineProcessorContract({
  slug: "agent-headless",
  version: AgentProcessorContract.version,
  description:
    "The agent loop WITHOUT response interpretation: schedules debounced turns and runs them " +
    "through the LLM transport, then stops — assistant output lands on the stream as raw " +
    "context and nothing platform-side parses it. Userland (typically the project's config " +
    "worker) interprets responses and appends the consequences itself: script-run-requested, " +
    "web-message-sent, summary-updated, corrective feedback, and the settlement rendering " +
    "that drives the next turn. An agent opts in by retargeting its wake subscription from " +
    'the "agent" slug to this one (same subscriptionKey — a reversible upsert).',
  stateSchema: AgentProcessorContract.stateSchema,
  processorDeps: AgentProcessorContract.processorDeps,
  events: AgentProcessorContract.events,
  consumes: AgentProcessorContract.consumes,
  emits: AgentProcessorContract.emits,
});

export type HeadlessAgentProcessorContract = typeof HeadlessAgentProcessorContract;

/**
 * The headless agent processor: the SAME wiring as `AgentProcessor` minus
 * the codemode component — turn loop plus LLM request, nothing that
 * interprets assistant output. See the contract description for who does the
 * interpreting instead. Idempotency keys still mint in the fixed `agent/`
 * namespace (via `agentComponentHost`), so handing a stream between the
 * classic and headless processors dedupes every recorded consequence —
 * turns already run are never re-run, scripts already requested are never
 * re-requested.
 */
export class HeadlessAgentProcessor extends StreamProcessor<
  HeadlessAgentProcessorContract,
  AgentProcessorDeps
> {
  readonly contract = HeadlessAgentProcessorContract;
  readonly #components = (() => {
    const host = agentComponentHost(this);
    const llm = new AgentLlmRequest(host);
    return [new AgentTurnLoop(host, llm), llm];
  })();

  protected override processEvent(
    args: ProcessEventArgs<HeadlessAgentProcessorContract>,
  ): undefined {
    // Act only when SELECTED (config.driver): hosted-processor subscriptions
    // cannot be removed, so the handover is additive — subscribe this
    // processor, flip the driver knob — and this guard is what makes exactly
    // one loop act while both stay subscribed.
    if (args.state.config.driver !== "agent-headless") return;
    for (const component of this.#components) component.processEvent(args);
  }

  protected override reduce({ event, state }: ReduceArgs<HeadlessAgentProcessorContract>) {
    return reduceAgentEvent({ event, state });
  }
}
