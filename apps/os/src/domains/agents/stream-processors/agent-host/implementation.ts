// Implements the "agent-host" processor as a class-based StreamProcessor.
//
// Recreated from the inline `createAgentHostProcessor` that used to live in
// the deleted legacy stream-processor runner. The host-side-effect handlers
// moved here from agent-durable-object.ts; keeping them out of the Durable
// Object module avoids a runtime import cycle now that the DO constructs this
// processor in a class field initializer.

import type { Event, EventInput, StreamPath } from "@iterate-com/shared/streams/types";
import { StreamPath as StreamPathSchema } from "@iterate-com/shared/streams/types";
import type { StreamEventInput } from "@iterate-com/streams/shared/event";
import { StreamProcessor } from "@iterate-com/streams/stream-processor";
import { AgentHostProcessorContract } from "./contract.ts";
import {
  AGENTS_STREAM_PATH,
  getAgentDurableObjectName,
} from "~/domains/agents/agent-stream-subscriptions.ts";
import { toLegacyEvent, toNewEventInput } from "~/domains/streams/new-stream-runtime.ts";
import type { ItxRuntime } from "~/itx/handle.ts";
import { runItxScript } from "~/itx/run.ts";
import type { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";

export { AGENT_HOST_PROCESSOR_SLUG, AgentHostProcessorContract } from "./contract.ts";

export type AgentHostProcessorContract = typeof AgentHostProcessorContract;

// Core lifecycle event type emitted by the @iterate-com/streams runtime. Uses the
// `events.iterate.com/stream/` prefix (NOT the legacy `@iterate-com/shared/streams` `/core/`
// prefix, which never matches new-runtime events).
const STREAM_CHILD_STREAM_CREATED_TYPE = "events.iterate.com/stream/child-stream-created";

export type AgentHostProcessorDeps = {
  agentNamespace: DurableObjectNamespace<AgentDurableObject> | undefined;
  /** Ensures (and returns) the agent's itx child context id. */
  getItxContextId: () => Promise<string>;
  /** The worker env + exports the script runner needs (LOADER/STREAM/exports). */
  runnerEnv: Env;
  workerExports: unknown;
  /**
   * Resolves the stream this processor is attached to. Read lazily from the
   * host's subscription state because the processor is constructed at DO
   * field-init time, before any subscription handshake has happened.
   */
  getStreamContext(): { projectId: string; streamPath: StreamPath };
};

export class AgentHostProcessor extends StreamProcessor<
  AgentHostProcessorContract,
  AgentHostProcessorDeps
> {
  readonly contract = AgentHostProcessorContract;

  // Once per DO incarnation, not per event: initialize() is idempotent, and any
  // delivered event implies activity worth ensuring the agent for.
  #ensuredOwnAgent = false;

  protected override processEvent(
    args: Parameters<StreamProcessor<AgentHostProcessorContract>["processEvent"]>[0],
  ): void {
    const { projectId, streamPath } = this.deps.getStreamContext();
    const event = toLegacyEvent(args.event, streamPath);

    // Wake this stream's agent WITHOUT blocking the host's checkpoint. The agent's
    // onInstanceWake waits for every processor on the stream (including this agent-host) to
    // catch up; awaiting it inside blockProcessorWhile would deadlock the host against itself.
    // runInBackground runs it detached so the host advances and the catch-up can complete.
    //
    // Triggered by ANY event past the side-effect anchor rather than by
    // `stream/created`: on routed streams the created event predates this
    // processor's subscription, so an anchor-gated created-only trigger would
    // never fire (the anchor skips historical side effects by design).
    if (!this.#ensuredOwnAgent) {
      this.#ensuredOwnAgent = true;
      args.runInBackground(() =>
        ensureAgentRunnerForOwnStream({
          agentNamespace: this.deps.agentNamespace,
          projectId,
          streamPath,
        }),
      );
    }
    // Script execution runs DETACHED: scripts can be long, and the two-event
    // itx execution record (requested/completed on this stream) is the
    // durable trace. The completion handler below turns the completed event
    // into agent input on a later delivery.
    const script = extractAgentScript({ event, streamPath });
    if (script != null) {
      args.runInBackground(() =>
        runAgentItxScript({
          code: script,
          deps: this.deps,
          projectId,
          streamPath,
        }),
      );
    }

    // Enqueued executions (e.g. Slack bang commands): another processor
    // appended itx/execution-requested with `enqueued: true`; this host is
    // the runner. The flag distinguishes queue entries from the records
    // runItxScript appends about its own runs.
    if (
      event.type === "events.iterate.com/itx/execution-requested" &&
      streamPath !== AGENTS_STREAM_PATH
    ) {
      const payload = event.payload as {
        code?: unknown;
        enqueued?: unknown;
        executionId?: unknown;
      };
      if (payload.enqueued === true && typeof payload.code === "string") {
        const code = payload.code;
        const executionId =
          typeof payload.executionId === "string" ? payload.executionId : undefined;
        args.runInBackground(() =>
          runAgentItxScript({
            code,
            deps: this.deps,
            executionId,
            projectId,
            recordRequested: false,
            streamPath,
          }),
        );
      }
    }

    args.blockProcessorWhile(async () => {
      await ensureChildAgentRunner({
        agentNamespace: this.deps.agentNamespace,
        event,
        projectId,
      });
      await handleItxExecutionCompletedForAgent({
        appendInput: async (input) => {
          await this.ctx.stream.append({
            event: toNewEventInput(input.event) as StreamEventInput,
          });
        },
        event,
        streamPath,
      });
    });
  }
}

export async function ensureChildAgentRunner(args: {
  agentNamespace: DurableObjectNamespace<AgentDurableObject> | undefined;
  event: Event;
  projectId: string;
}) {
  if (args.agentNamespace === undefined) return;
  if (args.event.type !== STREAM_CHILD_STREAM_CREATED_TYPE) return;

  const payload = args.event.payload as { childPath?: unknown };
  const childPath = StreamPathSchema.safeParse(payload.childPath);
  if (!childPath.success) return;

  const name = getAgentDurableObjectName({
    agentPath: childPath.data,
    projectId: args.projectId,
  });
  const stub = args.agentNamespace.getByName(name);
  await stub.initialize({ name });
}

// Ensures the AgentDurableObject for the stream the host processor is running on is initialized.
//
// Agent streams created by routing (e.g. Slack-routed `/agents/slack/<channel>/<ts>` streams) are
// bootstrapped with only the `slack-agent` and `agent-host` subscriptions. Unlike the UI new-agent
// flow, nothing registers the LLM processors (`agent-chat`/`agent`/the provider processor) or seeds
// the agent setup events. Waking the AgentDurableObject here runs its `onInstanceWake` hook, which
// registers those processors and setup events.
export async function ensureAgentRunnerForOwnStream(args: {
  agentNamespace: DurableObjectNamespace<AgentDurableObject> | undefined;
  projectId: string;
  streamPath: StreamPath;
}) {
  if (args.agentNamespace === undefined) return;
  // The `/agents` root DO is created explicitly by the project lifecycle; it is not an agent.
  if (args.streamPath === AGENTS_STREAM_PATH) return;

  const name = getAgentDurableObjectName({
    agentPath: args.streamPath,
    projectId: args.projectId,
  });
  const stub = args.agentNamespace.getByName(name);
  await stub.initialize({ name });
}

export function extractAgentScript(args: { event: Event; streamPath: StreamPath }): string | null {
  if (args.streamPath === AGENTS_STREAM_PATH) return null;
  if (args.event.type !== "events.iterate.com/agent/output-added") return null;
  const payload = args.event.payload as { content?: unknown };
  if (typeof payload.content !== "string") return null;
  return extractCodemodeScript(payload.content);
}

export async function runAgentItxScript(args: {
  code: string;
  deps: Pick<AgentHostProcessorDeps, "getItxContextId" | "runnerEnv" | "workerExports">;
  executionId?: string;
  projectId: string;
  recordRequested?: boolean;
  streamPath: StreamPath;
}) {
  const contextId = await args.deps.getItxContextId();
  await runItxScript({
    // LLM scripts are written `async (ctx) => { … }` — ctx IS the itx handle
    // (the agent's caps and built-ins line up name-for-name), so the runner
    // invokes them directly and the execution record carries exactly what
    // the model wrote, no wrapper.
    convention: "ctx",
    executionId: args.executionId,
    recordRequested: args.recordRequested,
    env: args.deps.runnerEnv,
    exports: args.deps.workerExports as ItxRuntime["exports"],
    functionSource: args.code,
    projectId: args.projectId,
    props: { context: contextId },
    record: { namespace: args.projectId, path: args.streamPath },
  });
}

export async function handleItxExecutionCompletedForAgent(args: {
  appendInput(input: { event: EventInput }): Promise<unknown>;
  event: Event;
  streamPath: StreamPath;
}) {
  if (args.streamPath === AGENTS_STREAM_PATH) return;
  if (args.event.type !== "events.iterate.com/itx/execution-completed") return;

  const payload = args.event.payload as {
    error?: unknown;
    executionId?: unknown;
    logs?: unknown;
    ok?: unknown;
    result?: unknown;
  };
  if (typeof payload.executionId !== "string") return;

  const logs = Array.isArray(payload.logs) ? (payload.logs as string[]) : [];
  const outcome =
    payload.ok === true
      ? ({ status: "returned", value: payload.result } as const)
      : ({ error: payload.error ?? "Unknown script error", status: "threw" } as const);
  // A script that returned nothing and logged nothing needs no agent input
  // (matches the old codemode behaviour for undefined results).
  if (outcome.status === "returned" && outcome.value === undefined && logs.length === 0) return;

  await args.appendInput({
    event: {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: `agent-itx-execution-result:${payload.executionId}`,
      payload: {
        content: itxCompletionInputBlock({ event: args.event, logs, outcome }),
        llmRequestPolicy: { behaviour: "after-current-request" },
      },
    },
  });
}

const CODEMODE_FENCE_RE =
  /^```(?:js|javascript|codemode|ts|typescript)\s*\n([\s\S]*?)(?:\n```\s*)?$/;

export function extractCodemodeScript(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith("async (ctx) => {") && trimmed.endsWith("}")) {
    return trimmed;
  }

  if (trimmed.startsWith("async () => {") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = CODEMODE_FENCE_RE.exec(trimmed);
  return fenced?.[1]?.trim() || null;
}

function formatCodemodeOutput(output: unknown) {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output, null, 2) ?? String(output);
  } catch {
    return String(output);
  }
}

export function itxCompletionInputBlock(input: {
  event: Event;
  logs: string[];
  outcome: { status: "returned"; value: unknown } | { status: "threw"; error: unknown };
}) {
  const executionId = (input.event.payload as { executionId?: unknown }).executionId;
  return [
    "```yaml",
    "event:",
    `  offset: ${input.event.offset}`,
    "  type: events.iterate.com/itx/execution-completed",
    ...(typeof executionId === "string" ? [`  executionId: ${yamlScalar(executionId)}`] : []),
    "  outcome:",
    `    status: ${input.outcome.status}`,
    ...yamlBlockScalar(
      input.outcome.status === "returned" ? "    value" : "    error",
      formatCodemodeOutput(
        input.outcome.status === "returned" ? input.outcome.value : input.outcome.error,
      ),
    ),
    ...(input.logs.length > 0 ? yamlBlockScalar("  console", input.logs.join("\n")) : []),
    "```",
  ].join("\n");
}

function yamlScalar(value: string): string {
  if (/^[a-zA-Z0-9._/@:-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function yamlBlockScalar(key: string, value: string): string[] {
  return [`${key}: |-`, ...value.split("\n").map((line) => `      ${line}`)];
}
