import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import { defineProcessorContract } from "iterate/processors";
import type { AgentComponent, AgentHost, AgentProcessorDeps } from "./agent-host.ts";
import { AgentLlmRequest } from "./agent-llm-request.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { reduceAgentEvent } from "./agent-prompt-fold.ts";
import { AgentTurnLoop } from "./agent-turn-loop.ts";

// Established import sites, preserved across the classic processor's
// deletion: deps/transport types live in agent-host.ts, the LLM helpers in
// agent-llm-request.ts.
export type { AgentProcessorDeps } from "./agent-host.ts";

/**
 * The HEADLESS agent contract: the agent contract verbatim — same state
 * schema, same event vocabulary, same consumes/emits — under its own slug
 * (the registry routes wakes by slug, and this slug predates the classic
 * processor's deletion; renaming it is deliberately deferred). The shared
 * version string is deliberate: the two contracts must never drift, they are
 * one vocabulary hosted two ways — the `agent` slug remains the vocabulary's
 * home (docs, parsing, reads) while THIS slug is the one keeper that runs.
 */
export const HeadlessAgentProcessorContract = defineProcessorContract({
  slug: "agent-headless",
  version: AgentProcessorContract.version,
  description:
    "The one built-in agent keeper: schedules debounced turns, holds them until the project's " +
    "config worker finalizes the agent's birth (agent/birth-finalized, with a degraded-start " +
    "deadline), runs them through the LLM transport, then stops — assistant output lands on " +
    "the stream as raw context and nothing platform-side parses it. Userland (typically the " +
    "config worker) interprets responses per event through " +
    "itx.agents.get(path).interpretResponse, or vendors its own interpreter.",
  stateSchema: AgentProcessorContract.stateSchema,
  processorDeps: AgentProcessorContract.processorDeps,
  events: AgentProcessorContract.events,
  consumes: AgentProcessorContract.consumes,
  emits: AgentProcessorContract.emits,
});

export type HeadlessAgentProcessorContract = typeof HeadlessAgentProcessorContract;

/**
 * The headless agent processor — the ONLY built-in agent program: the turn
 * loop plus the LLM request component over the shared reduce
 * (`reduceAgentEvent`, agent-prompt-fold.ts — also imported off-runtime by
 * lib/llm-request-replay.ts, so it stays transport-free). Nothing here
 * interprets assistant output: interpretation is the per-event service in
 * agent-response-interpreter.ts, invoked only when project code asks.
 * Idempotency keys mint in the fixed `agent/` namespace (via
 * `agentComponentHost`), shared with the interpretation service, so streams
 * written by both converge on identical keys.
 */
export class HeadlessAgentProcessor extends StreamProcessor<
  HeadlessAgentProcessorContract,
  AgentProcessorDeps
> {
  readonly contract = HeadlessAgentProcessorContract;
  readonly #components: AgentComponent[] = (() => {
    const host = agentComponentHost(this);
    const llm = new AgentLlmRequest(host);
    return [new AgentTurnLoop(host, llm), llm];
  })();

  protected override processEvent(
    args: ProcessEventArgs<HeadlessAgentProcessorContract>,
  ): undefined {
    for (const component of this.#components) component.processEvent(args);
  }

  protected override reduce({ event, state }: ReduceArgs<HeadlessAgentProcessorContract>) {
    return reduceAgentEvent({ event, state });
  }
}

/** Adapts a hosting StreamProcessor to the component host surface. Usable by
 * any agent-contract processor class — call it with `this` from a field
 * initializer. The base class's members are protected, so the adapter
 * reaches them through a scoped cast rather than widening them to public.
 * `idempotencyKey` is pinned to the `agent/` namespace on purpose: every
 * writer of this stream's recorded consequences (this keeper, the
 * interpretation service, vendored userland interpreters) dedupes on
 * identical keys instead of re-executing under a fresh prefix. */
export function agentComponentHost(processor: object): AgentHost {
  const p = processor as {
    deps: AgentProcessorDeps;
    stream: { readEvents: AgentHost["readEvents"] };
    append: AgentHost["append"];
  };
  return {
    deps: p.deps,
    idempotencyKey: (suffix) => `agent/${suffix}`,
    readEvents: (input) => p.stream.readEvents(input),
    append: (...events) => p.append(...events),
    now: () => p.deps.now?.() ?? Date.now(),
    sleep: (ms) =>
      p.deps.sleep === undefined
        ? new Promise((resolve) => setTimeout(resolve, ms))
        : p.deps.sleep(ms),
  };
}
