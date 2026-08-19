import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import { AgentCodemode } from "./agent-codemode.ts";
import type { AgentHost, AgentProcessorDeps } from "./agent-host.ts";
import { AgentLlmRequest } from "./agent-llm-request.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { reduceAgentEvent } from "./agent-prompt-fold.ts";
import { AgentTurnLoop } from "./agent-turn-loop.ts";

// Established import sites, preserved across the split: deps/transport types
// live in agent-host.ts, the LLM helpers in agent-llm-request.ts.
export type { AgentProcessorDeps } from "./agent-host.ts";
export {
  buildAgentCompactionRequestBody,
  contextWindowTokens,
  prepareAgentLlmMessages,
} from "./agent-llm-request.ts";

/**
 * The agent processor, in three parts over one shared reduced state (the
 * split: tasks/agent-processor-split-codemode.md):
 *
 * - `AgentTurnLoop` (agent-turn-loop.ts) — the conversational loop: chat
 *   mirroring, waiting clears, interrupts, error transcription, and the
 *   at-head lifecycle (resume, breaker, debounced intent, adopt/expire).
 * - `AgentLlmRequest` (agent-llm-request.ts) — the model call: prompt
 *   assembly from committed history, transport attempts, chunk streaming,
 *   atomic settle appends, and compaction (an LLM request with the
 *   summarize instruction as its trailing message).
 * - `AgentCodemode` (agent-codemode.ts) — text ↔ scripts: slash commands,
 *   response parsing, and settlement rendering back into model-visible
 *   context. The one CONFIGURABLE part: `config.interpretResponses` off
 *   skips it entirely, and project code consumes the raw assistant output
 *   events and appends these same consequences itself.
 *
 * The parts communicate ONLY through events on the stream and the shared
 * reduce (`reduceAgentEvent`, agent-prompt-fold.ts — also imported
 * off-runtime by lib/llm-request-replay.ts, so it stays transport-free); the
 * one in-memory edge is the turn loop telling the LLM part to run or abort.
 *
 * Idempotency keys are minted in the FIXED `agent/` namespace, so a
 * userland interpreter appending the same recorded consequences dedupes
 * against this processor instead of double-executing.
 */
export class AgentProcessor extends StreamProcessor<AgentProcessorContract, AgentProcessorDeps> {
  readonly contract = AgentProcessorContract;
  readonly #host = this.#makeHost();
  readonly #llm = new AgentLlmRequest(this.#host);
  readonly #turnLoop = new AgentTurnLoop(this.#host, this.#llm);
  readonly #codemode = new AgentCodemode(this.#host);

  protected override processEvent(args: ProcessEventArgs<AgentProcessorContract>): undefined {
    this.#turnLoop.processEvent(args);
    this.#llm.processEvent(args);
    // The interpretation switch: off, assistant output stays raw on the
    // stream — no slash commands, no response parsing, no settlement
    // rendering. Flipping mid-life is safe because a userland interpreter
    // mints the same `agent/` keys, so overlap dedupes instead of
    // double-executing.
    if (args.state.config.interpretResponses) this.#codemode.processEvent(args);
  }

  // Pure reduce. The one switch lives in the module-level `reduceAgentEvent`
  // (not inline here) because two OFF-RUNTIME readers run the exact same
  // projection over raw stream events: prompt building (the request is a
  // pure re-reduction pinned to the requested offset) and the UI's request
  // inspector (lib/llm-request-replay.ts replays the wire messages from
  // mirrored events via `reduceAgentEvents`).
  protected override reduce({ event, state }: ReduceArgs<AgentProcessorContract>) {
    return reduceAgentEvent({ event, state });
  }

  /** The surface the three parts borrow from this processor: deps, the key
   * mint (pinned to the `agent/` namespace — see the class doc), stream
   * reads, the out-of-frame append, and the injectable clock. */
  #makeHost(): AgentHost {
    return {
      deps: this.deps,
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
