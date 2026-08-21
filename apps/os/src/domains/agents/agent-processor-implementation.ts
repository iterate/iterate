import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import type { AgentComponent, AgentHost, AgentProcessorDeps } from "./agent-host.ts";
import { AgentLlmRequest } from "./agent-llm-request.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { reduceAgentEvent } from "./agent-prompt-fold.ts";
import { AgentTurnLoop } from "./agent-turn-loop.ts";

// Established import sites, preserved across the refactors: deps/transport
// types live in agent-host.ts, the LLM helpers in agent-llm-request.ts.
export type { AgentProcessorDeps } from "./agent-host.ts";

/**
 * The ONE agent processor: the turn loop plus the LLM request
 * component over the shared reduce (`reduceAgentEvent`,
 * agent-prompt-fold.ts — also imported off-runtime by
 * lib/llm-request-replay.ts, so it stays transport-free). It schedules
 * debounced turns, holds them until the project's config worker finalizes
 * the agent's birth (agent/birth-finalized, with a degraded-start deadline),
 * runs them through the LLM transport, then stops — assistant output lands
 * on the stream as raw context and nothing here parses it. Interpretation is
 * the per-event service in agent-response-interpreter.ts
 * (itx.agents.get(path).interpretResponse), invoked only when project code
 * asks; projects may vendor their own interpreter instead.
 *
 * Registered under the contract's own slug ("agent"). History: during the
 * birth-userland transition this processor briefly lived under a second slug
 * ("agent-headless"), beside the (now deleted) classic interpreting processor;
 * with one processor left, the split contract was dissolved and the slug
 * reclaimed. Idempotency keys mint in the fixed `agent/` namespace (via
 * `#componentHost`), shared with the interpretation service, so streams
 * written by both converge on identical keys.
 */
export class AgentProcessor extends StreamProcessor<AgentProcessorContract, AgentProcessorDeps> {
  readonly contract = AgentProcessorContract;
  readonly #components: AgentComponent[] = (() => {
    const host = this.#componentHost();
    const llm = new AgentLlmRequest(host);
    return [new AgentTurnLoop(host, llm), llm];
  })();

  protected override processEvent(args: ProcessEventArgs<AgentProcessorContract>): undefined {
    for (const component of this.#components) component.processEvent(args);
  }

  protected override reduce({ event, state }: ReduceArgs<AgentProcessorContract>) {
    return reduceAgentEvent({ event, state });
  }

  /** The component host surface over this processor's protected members.
   * `idempotencyKey` is pinned to the `agent/` namespace on purpose: every
   * writer of this stream's recorded consequences (this processor, the
   * interpretation service, vendored userland interpreters) dedupes on
   * identical keys instead of re-executing under a fresh prefix. */
  #componentHost(): AgentHost {
    if (this.projectId === null) {
      throw new Error("agent streams are always project-scoped");
    }
    return {
      deps: this.deps,
      identity: { agentPath: this.path, projectId: this.projectId },
      idempotencyKey: (suffix) => `agent/${suffix}`,
      readEvents: (input) => this.stream.readEvents(input),
      append: (...events) => this.append(...events),
      now: () => this.deps.now?.() ?? Date.now(),
      sleep: (ms) =>
        this.deps.sleep === undefined
          ? new Promise((resolve) => setTimeout(resolve, ms))
          : this.deps.sleep(ms),
    };
  }
}
