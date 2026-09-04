// What the agent processor's parts borrow from the owning StreamProcessor.
// The processor is split into three parts — AgentTurnLoop
// (agent-turn-loop.ts), AgentLlmRequest (agent-llm-request.ts), AgentCodemode
// (agent-codemode.ts) — and this host is the whole surface they share: deps,
// the key mint, stream reads, the processor's own out-of-frame append, and
// the injectable clock. Built by AgentProcessor#makeHost
// (agent-processor-implementation.ts).

import { isIdempotencyConflict } from "iterate/processors";
import type { EmittedInput, ProcessEventArgs, StreamEvent } from "iterate/processors";
import type { AgentConfigRepoFileReferenceTarget } from "@iterate-com/shared/agent-rich-content";
import type { AgentFileAttachment, AgentProcessorContract } from "./agent-processor-contract.ts";
import type { AgentReferenceReadResult } from "./agent-reference-materialization.ts";
import type {
  WorkersAiBinding,
  CloudflareAiGatewayTransport,
  WorkersAiMessage,
} from "./workers-ai-transport.ts";

/** The test/custom-host LLM seam: when provided it REPLACES the Workers AI
 * path entirely, so suites drive turns with a scripted transport and the
 * processor never knows. `onChunk` receives text deltas. Usage comes back
 * already normalized. */
export type AgentLlmTransport = (args: {
  model: string;
  messages: WorkersAiMessage[];
  signal: AbortSignal;
  /** The transport awaits each result before delivering the next chunk. */
  onChunk?: (text: string) => Promise<void>;
}) => Promise<{
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
  };
  rawResponse?: unknown;
}>;

/**
 * Host-provided deps beyond the stream plumbing.
 *
 * - `ai` is the Workers AI binding (`env.AI`) used for every LLM turn.
 *   Optional so a host without one fails requests with a recorded error
 *   instead of crashing at construction.
 * - `cloudflareAiGatewayTransport` resolves how attempts travel through the
 *   gateway (unified billing vs the BYOK lane — see
 *   CloudflareAiGatewayTransport). A function, not a value: it reads
 *   deployment config and the host's secrets, and a bad config must fail the
 *   ATTEMPT (recorded, retried) rather than DO construction.
 * - `resolveModelFileUrl` remints a short-lived, immutable URL for a project
 *   file immediately before a model request. Production hosts provide it;
 *   bare tests without it retain the stored attachment URL.
 * - `readRepoFile` resolves a bounded prefix of one semantic config-repo
 *   reference at latest HEAD. The processor commits that source material
 *   before scheduling a turn.
 * - `writeWorkspaceFile` writes one file into THIS agent's own workspace
 *   directory (the filesystem `itx.workspace` resolves to; the given path is
 *   relative to that directory) so oversized script results can spill to a
 *   file the model pages through with plain TypeScript. Returns the
 *   fully-qualified workspace path it wrote. Optional: without it, oversized
 *   results fall back to inline truncation.
 * - `callLlm` overrides the whole Workers AI path when provided — the test
 *   seam (see AgentLlmTransport).
 * - `consultAiInterceptor` serves `intercepted/*` model attempts through the
 *   project's live AI interceptor (`itx.ai.intercept`): production hosts
 *   provide the project-DO hop; a host without it fails intercepted/* attempts with
 *   a recorded error, like any other attempt failure.
 * - `now`/`sleep`: injectable clock — virtual time in tests, real time in
 *   production.
 */
export type AgentProcessorDeps = {
  ai?: WorkersAiBinding;
  cloudflareAiGatewayTransport?: () => CloudflareAiGatewayTransport;
  consultAiInterceptor?: (input: {
    source: "agent-turn";
    agentPath: string;
    model: string;
    body: { messages: WorkersAiMessage[] };
  }) => Promise<unknown>;
  resolveModelFileUrl?: (file: AgentFileAttachment) => Promise<string>;
  readRepoFile?: (
    target: AgentConfigRepoFileReferenceTarget,
    maximumBytes: number,
  ) => Promise<AgentReferenceReadResult | null>;
  writeWorkspaceFile?: (input: {
    content: string;
    path: string;
  }) => Promise<{ absolutePath: string }>;
  callLlm?: AgentLlmTransport;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type AgentHost = {
  path: string;
  deps: AgentProcessorDeps;
  /**
   * Mints `agent/<suffix>` — the FIXED namespace: a userland interpreter
   * (an agent with `interpretResponses` off) appends the same recorded
   * consequences under identical keys, so any overlap with this processor
   * dedupes instead of re-executing scripts.
   */
  idempotencyKey: (suffix: string) => string;
  /** Page reader over the home stream (prompt building, compaction guards). */
  readEvents: (input: {
    afterOffset: number;
    eventTypes?: readonly string[];
    limit: number;
  }) => AsyncEventPager;
  /** The processor's own out-of-frame append (compaction's summary item). */
  append: (...events: EmittedInput<AgentProcessorContract>[]) => Promise<unknown>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/** The slice of ProcessorStream's pager the components consume. */
export type AsyncEventPager = {
  next: () => Promise<StreamEvent[]>;
  [Symbol.dispose]: () => void;
};

/**
 * Append a batch whose idempotency keys may race concurrent writers: every
 * writer of `settle/<offset>` (success, failure, interrupt, expiry) races
 * every other, and two debounce schedulings of one trigger race on
 * `request/<offset>` when config changed between them. The stream rejects
 * a same-key append with a different body; the FIRST writer's story stands
 * and losing the race is success — the obligation is settled/recorded, and
 * the reduce sorts out whose fact counts.
 */
export async function appendUnlessLostIdempotencyRace(
  append: ProcessEventArgs<AgentProcessorContract>["append"],
  events: EmittedInput<AgentProcessorContract>[],
): Promise<void> {
  try {
    await append(...events);
  } catch (error) {
    if (!isIdempotencyConflict(error)) throw error;
  }
}

export function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
