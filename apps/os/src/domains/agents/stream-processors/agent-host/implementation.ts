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
import { startCodemodeScriptOnExistingSession } from "~/domains/codemode/codemode-session-rpc.ts";
import type { CodemodeSession } from "~/domains/codemode/durable-objects/codemode-session.ts";
import { toLegacyEvent, toNewEventInput } from "~/domains/streams/new-stream-runtime.ts";
import type { AgentDurableObject } from "~/domains/agents/durable-objects/agent-durable-object.ts";

export { AGENT_HOST_PROCESSOR_SLUG, AgentHostProcessorContract } from "./contract.ts";

export type AgentHostProcessorContract = typeof AgentHostProcessorContract;

// Core lifecycle event types emitted by the @iterate-com/streams runtime. These use the
// `events.iterate.com/stream/` prefix (NOT the legacy `@iterate-com/shared/streams` `/core/`
// prefix, which never matches new-runtime events).
const STREAM_CREATED_TYPE = "events.iterate.com/stream/created";
const STREAM_CHILD_STREAM_CREATED_TYPE = "events.iterate.com/stream/child-stream-created";

export type AgentHostProcessorDeps = {
  agentNamespace: DurableObjectNamespace<AgentDurableObject> | undefined;
  codemodeSessionNamespace: DurableObjectNamespace<CodemodeSession> | undefined;
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

  protected override processEvent(
    args: Parameters<StreamProcessor<AgentHostProcessorContract>["processEvent"]>[0],
  ): void {
    const { projectId, streamPath } = this.deps.getStreamContext();
    const event = toLegacyEvent(args.event, streamPath);

    // Wake this stream's agent WITHOUT blocking the host's checkpoint. The agent's
    // onInstanceWake waits for every processor on the stream (including this agent-host) to
    // catch up; awaiting it inside blockProcessorWhile would deadlock the host against itself.
    // runInBackground runs it detached so the host advances and the catch-up can complete.
    args.runInBackground(() =>
      ensureAgentRunnerForOwnStream({
        agentNamespace: this.deps.agentNamespace,
        event,
        projectId,
        streamPath,
      }),
    );
    args.blockProcessorWhile(async () => {
      await ensureChildAgentRunner({
        agentNamespace: this.deps.agentNamespace,
        event,
        projectId,
      });
      await handleAgentOutputAddedForCodemode({
        codemodeSessionNamespace: this.deps.codemodeSessionNamespace,
        event,
        projectId,
        streamPath,
      });
      await handleCodemodeScriptExecutionCompletedForAgent({
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
  event: Event;
  projectId: string;
  streamPath: StreamPath;
}) {
  if (args.agentNamespace === undefined) return;
  if (args.event.type !== STREAM_CREATED_TYPE) return;
  // The `/agents` root DO is created explicitly by the project lifecycle; it is not an agent.
  if (args.streamPath === AGENTS_STREAM_PATH) return;

  const name = getAgentDurableObjectName({
    agentPath: args.streamPath,
    projectId: args.projectId,
  });
  const stub = args.agentNamespace.getByName(name);
  await stub.initialize({ name });
}

export async function handleAgentOutputAddedForCodemode(args: {
  codemodeSessionNamespace: DurableObjectNamespace<CodemodeSession> | undefined;
  event: Event;
  projectId: string;
  streamPath: StreamPath;
}) {
  if (args.codemodeSessionNamespace === undefined) return;
  if (args.streamPath === AGENTS_STREAM_PATH) return;
  if (args.event.type !== "events.iterate.com/agent/output-added") return;

  const payload = args.event.payload as { content?: unknown };
  if (typeof payload.content !== "string") return;

  const code = extractCodemodeScript(payload.content);
  if (code == null) return;

  await startCodemodeScriptOnExistingSession({
    code,
    events: [],
    namespace: args.codemodeSessionNamespace,
    projectId: args.projectId,
    streamPath: args.streamPath,
  });
}

export async function handleCodemodeScriptExecutionCompletedForAgent(args: {
  appendInput(input: { event: EventInput }): Promise<unknown>;
  event: Event;
  streamPath: StreamPath;
}) {
  if (args.streamPath === AGENTS_STREAM_PATH) return;
  if (args.event.type !== "events.iterate.com/codemode/script-execution-completed") return;

  const payload = args.event.payload as {
    outcome?: unknown;
    scriptExecutionId?: unknown;
  };
  const outcome = payload.outcome;
  if (outcome == null || typeof outcome !== "object") return;

  const status = "status" in outcome ? outcome.status : undefined;
  if (status === "returned") {
    const value = "value" in outcome ? outcome.value : undefined;
    if (value === undefined) return;
    await args.appendInput({
      event: {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: `agent-codemode-script-result:${String(payload.scriptExecutionId)}`,
        payload: {
          content: codemodeCompletionInputBlock({
            event: args.event,
            outcome: {
              status,
              value,
            },
          }),
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
    });
    return;
  }

  if (status === "threw") {
    const error = "error" in outcome ? outcome.error : "Unknown codemode error";
    await args.appendInput({
      event: {
        type: "events.iterate.com/agent/input-added",
        idempotencyKey: `agent-codemode-script-error:${String(payload.scriptExecutionId)}`,
        payload: {
          content: codemodeCompletionInputBlock({
            event: args.event,
            outcome: {
              error,
              status,
            },
          }),
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      },
    });
  }
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

export function codemodeCompletionInputBlock(input: {
  event: Event;
  outcome: { status: "returned"; value: unknown } | { status: "threw"; error: unknown };
}) {
  const scriptExecutionId = (input.event.payload as { scriptExecutionId?: unknown })
    .scriptExecutionId;
  return [
    "```yaml",
    "event:",
    `  offset: ${input.event.offset}`,
    "  type: events.iterate.com/codemode/script-execution-completed",
    ...(typeof scriptExecutionId === "string"
      ? [`  scriptExecutionId: ${yamlScalar(scriptExecutionId)}`]
      : []),
    "  outcome:",
    `    status: ${input.outcome.status}`,
    ...yamlBlockScalar(
      input.outcome.status === "returned" ? "    value" : "    error",
      formatCodemodeOutput(
        input.outcome.status === "returned" ? input.outcome.value : input.outcome.error,
      ),
    ),
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
