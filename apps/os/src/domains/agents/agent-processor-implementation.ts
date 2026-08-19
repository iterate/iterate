import { StreamProcessor } from "iterate/processors";
import type { ProcessEventArgs, ReduceArgs } from "iterate/processors";
import { AgentCodemode } from "./agent-codemode.ts";
import type { AgentComponent, AgentHost, AgentProcessorDeps } from "./agent-host.ts";
import { AgentLlmRequest } from "./agent-llm-request.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { reduceAgentEvent } from "./agent-prompt-fold.ts";
import { fencedTsResponseFormat, type AgentResponseFormat } from "./agent-response-format.ts";
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
 * The agent processor: a COMPOSITION of three components over one shared
 * reduced state. Design: tasks/simplify-stream-processor-contract.md,
 * tasks/agent-processor-replacement.md, and the split:
 * tasks/agent-processor-split-codemode.md.
 *
 * - `AgentTurnLoop` (agent-turn-loop.ts) — the conversational loop: chat
 *   mirroring, waiting clears, interrupts, error transcription, and the
 *   at-head lifecycle (resume, breaker, debounced intent, adopt/expire).
 * - `AgentLlmRequest` (agent-llm-request.ts) — the model call: prompt
 *   assembly from committed history, transport attempts, chunk streaming,
 *   atomic settle appends, and compaction (an LLM request with the
 *   summarize instruction as its trailing message).
 * - `AgentCodemode` (agent-codemode.ts) — text ↔ scripts: slash commands,
 *   response parsing through the injected `AgentResponseFormat`, and
 *   settlement rendering back into model-visible context.
 *
 * The components communicate ONLY through events on the stream and the
 * shared reduce (`reduceAgentEvent`, agent-prompt-fold.ts — also imported
 * off-runtime by lib/llm-request-replay.ts, so it stays transport-free); the
 * one in-memory edge is the turn loop telling the LLM component to run or
 * abort. The codemode component switches itself off when
 * `config.enableDefaultLlmResponseParsing` is false — project code consumes
 * the raw assistant output events and appends the consequences itself.
 *
 * Idempotency keys are minted in the FIXED `agent/` namespace, so a
 * userland interpreter appending the same recorded consequences dedupes
 * against this processor instead of double-executing.
 */
export class AgentProcessor extends StreamProcessor<AgentProcessorContract, AgentProcessorDeps> {
  readonly contract = AgentProcessorContract;
  readonly #components = buildAgentComponents(agentComponentHost(this), {
    format: fencedTsResponseFormat,
  });

  protected override processEvent(args: ProcessEventArgs<AgentProcessorContract>): undefined {
    for (const component of this.#components) component.processEvent(args);
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
}

/** The classic component set. A variant passes a different format — or
 * builds its own list without the codemode element. (Module-private until a
 * variant processor exists to import it.) */
function buildAgentComponents(
  host: AgentHost,
  options: { format: AgentResponseFormat },
): AgentComponent[] {
  const llm = new AgentLlmRequest(host);
  return [new AgentTurnLoop(host, llm), llm, new AgentCodemode(host, options.format)];
}

/** Adapts a hosting StreamProcessor to the component host surface. Usable by
 * any agent-contract processor class (the classic one here, variants
 * elsewhere) — call it with `this` from a field initializer. The base
 * class's members are protected, so the adapter reaches them through a
 * scoped cast rather than widening them to public. `idempotencyKey` is
 * pinned to the `agent/` namespace on purpose; see the class doc. */
function agentComponentHost(processor: object): AgentHost {
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
