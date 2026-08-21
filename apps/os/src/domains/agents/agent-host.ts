// What the agent components borrow from their owning StreamProcessor. The
// agent processor is a COMPOSITION of three components — AgentTurnLoop
// (agent-turn-loop.ts), AgentLlmRequest (agent-llm-request.ts), AgentCodemode
// (agent-codemode.ts) — and this host is the whole surface they share: deps,
// the key mint, stream reads, the processor's own out-of-frame append, and
// the injectable clock. A variant processor (a different response format, a
// different codemode component) builds the same host and swaps one element.

import { isIdempotencyConflict } from "iterate/processors";
import type { EmittedInput, ProcessEventArgs, StreamEvent } from "iterate/processors";
import type { AgentFileAttachment, AgentProcessorContract } from "./agent-processor-contract.ts";
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
 * - `writeWorkspaceFile` writes one file into THIS agent's own workspace
 *   directory (the filesystem `itx.workspace` resolves to; the given path is
 *   relative to that directory) so oversized script results can spill to a
 *   file the model pages through with plain TypeScript. Returns the
 *   fully-qualified workspace path it wrote. Optional: without it, oversized
 *   results fall back to inline truncation.
 * - `callLlm` overrides the whole Workers AI path when provided — the test
 *   seam (see AgentLlmTransport).
 * - `now`/`sleep`: injectable clock — virtual time in tests, real time in
 *   production.
 */
export type AgentProcessorDeps = {
  ai?: WorkersAiBinding;
  cloudflareAiGatewayTransport?: () => CloudflareAiGatewayTransport;
  resolveModelFileUrl?: (file: AgentFileAttachment) => Promise<string>;
  writeWorkspaceFile?: (input: {
    content: string;
    path: string;
  }) => Promise<{ absolutePath: string }>;
  callLlm?: AgentLlmTransport;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** One agent component: called for every delivery, exactly like the owning
 * processor's own `processEvent`. Components fold nothing themselves — they
 * read the shared reduced state off the frame args. */
export type AgentComponent = {
  processEvent: (args: ProcessEventArgs<AgentProcessorContract>) => undefined;
};

export type AgentHost = {
  deps: AgentProcessorDeps;
  /** The home stream's identity — agent streams are always project-scoped. */
  identity: { agentPath: string; projectId: string };
  /**
   * Mints `agent/<suffix>` — the FIXED namespace, deliberately NOT derived
   * from the hosting contract's slug: a stream handed from the classic
   * processor to a variant (or back) must dedupe every recorded consequence
   * on identical keys instead of re-executing scripts under a fresh prefix.
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
