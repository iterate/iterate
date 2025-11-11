import type { OpenAI } from "openai";
import { z } from "zod";
import { backcompat, JSONSerializable } from "../utils/type-helpers.ts";
import {
  FunctionCall,
  ImageGenerationCallOutput,
  ResponseInputItem,
  ResponseOutputItem,
} from "./openai-response-schemas.ts";
import type { Participant } from "./participant-schemas.ts";
import type { PromptFragment } from "./prompt-fragments.ts";
import { type MCPServer, type RuntimeTool, ToolSpec } from "./tool-schemas.ts";
import { ContextRule } from "./context-schemas.ts";

// ------------------------- Models -------------------------

export const SUPPORTED_MODELS = [
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
] as const;
export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export const DEFAULT_MODEL: SupportedModel = "gpt-5";

// ------------------------- Model Options Schema -------------------------

/**
 * Base model options schema that all models support
 */
export const BaseModelOpts = z.object({
  /** Tool choice strategy - controls when the model can use tools */
  toolChoice: z.enum(["none", "auto", "required"]).default("auto").optional(),
  /** Temperature parameter - defaults to 1 */
  temperature: z.number().default(1).optional(),
  /** Service tier - defaults to priority, more expensive but faster */
  service_tier: z
    .enum(["auto", "default", "flex", "priority", "scale"])
    .default("priority")
    .optional(),
});

/**
 * Schema for model options that can be supplied to the LLM. We expose this so
 * that other slices (e.g. the hand-off slice) can reference the exact same
 * shape instead of duplicating it.
 */
export const ModelOpts = z.discriminatedUnion("model", [
  // GPT-5 specific options - temperature MUST be 1
  BaseModelOpts.extend({
    /** The model name to use */
    model: z.enum(["gpt-5", "gpt-5-mini", "gpt-5-nano"]),
    /** Temperature parameter - MUST be 1 for gpt-5 */
    temperature: z.literal(1).default(1).optional(),
    /** GPT-5 specific reasoning options */
    reasoning: z
      .object({
        effort: z.enum(["minimal", "low", "medium", "high"]),
        summary: z.enum(["auto", "concise", "detailed"]).nullish(),
      })
      .optional(),
    /** GPT-5 specific text formatting options */
    text: z
      .object({
        verbosity: z.enum(["low", "medium", "high"]),
      })
      .optional(),
  }),
  // Other models (gpt-4.1, gpt-4.1-mini)
  BaseModelOpts.extend({
    /** The model name to use */
    model: z.enum(["gpt-4.1", "gpt-4.1-mini", "gpt-4o-mini"]),
  }),
]);

export type ModelOpts = z.infer<typeof ModelOpts>;
export type ModelOptsInput = z.input<typeof ModelOpts>;

/**
 * Default model options - gpt-5-mini with minimal reasoning and concise text, temperature 1
 */
export const DEFAULT_MODEL_OPTS: ModelOpts = {
  model: "gpt-5",
  temperature: 1,
  reasoning: { effort: "minimal", summary: null },
  text: { verbosity: "low" },
  service_tier: "priority",
} as const;

// Base schemas - these are splatted into all other schemas
// Prefer this over zod extend for typescript inference performance reasons
export const agentCoreBaseEventFields = {
  type: z.string(),
  data: z.object({}).optional(),
  metadata: z.record(z.string(), JSONSerializable).optional(),
  triggerLLMRequest: z.boolean().optional(),
  createdAt: z.string().optional(),
  eventIndex: z.number().optional(),
  idempotencyKey: z.string().optional(),
};

export const AgentCoreBaseEvent = z.object({
  ...agentCoreBaseEventFields,
});
export type AgentCoreBaseEvent = z.infer<typeof AgentCoreBaseEvent>;

// ------------------------- Event Schemas -------------------------

// CORE:LOCAL_FUNCTION_TOOL_CALL
const localFunctionToolCallEventFields = {
  type: z.literal("CORE:LOCAL_FUNCTION_TOOL_CALL"),
  data: z.object({
    call: FunctionCall,
    associatedReasoningItemId: z.string().optional(),
    result: z.discriminatedUnion("success", [
      z.object({
        success: z.literal(true),
        output: JSONSerializable,
      }),
      z.object({
        success: z.literal(false),
        error: z.string(),
      }),
    ]),
    executionTimeMs: z
      .number()
      .optional()
      .describe("Time taken to execute the tool in milliseconds"),
    llmRequestStartEventIndex: z
      .number()
      .optional()
      .describe(
        "Event index of the LLM request start event that triggered this tool call - links tool calls from the same request",
      ),
  }),
};
export const LocalFunctionToolCallEvent = z.object({
  ...agentCoreBaseEventFields,
  ...localFunctionToolCallEventFields,
});

export const ParticipantRole = z.enum(["member", "admin", "owner", "guest", "external"]);

export const ApprovalKey = z.string().brand("ApprovalKey");
export type ApprovalKey = z.infer<typeof ApprovalKey>;
const toolCallApprovalRequestedEventFields = {
  type: z.literal("CORE:TOOL_CALL_APPROVAL_REQUESTED"),
  data: z.object({
    approvalKey: ApprovalKey,
    toolName: z.string(),
    toolCallId: z.string(),
    args: z.unknown(),
  }),
};
export const ToolCallApprovalRequestedEvent = z.object({
  ...agentCoreBaseEventFields,
  ...toolCallApprovalRequestedEventFields,
});

const toolCallApprovalEventFields = {
  type: z.literal("CORE:TOOL_CALL_APPROVED"),
  data: z.object({
    approvalKey: ApprovalKey,
    approved: z.boolean(),
    approvedBy: z.object({
      userId: z.string(),
      orgRole: ParticipantRole.optional(),
    }),
  }),
};
export const ToolCallApprovalEvent = z.object({
  ...agentCoreBaseEventFields,
  ...toolCallApprovalEventFields,
});
export type ToolCallApprovalEvent = z.infer<typeof ToolCallApprovalEvent>;

// CORE:LLM_REQUEST_START
const llmRequestStartEventFields = {
  type: z.literal("CORE:LLM_REQUEST_START"),
  data: z
    .object({
      /** Raw request sent to OpenAI */
      rawRequest: z.unknown().optional(),
    })
    .optional(),
};
export const LlmRequestStartEvent = z.object({
  ...agentCoreBaseEventFields,
  ...llmRequestStartEventFields,
});

// CORE:LLM_REQUEST_END
const llmRequestEndEventFields = {
  type: z.literal("CORE:LLM_REQUEST_END"),
  data: backcompat({
    new: z.object({ rawResponse: z.unknown() }),
    old: z.record(z.string(), z.undefined()).nullish(),
    upgrade: () => ({ rawResponse: {} }),
  }),
};
export const LlmRequestEndEvent = z.object({
  ...agentCoreBaseEventFields,
  ...llmRequestEndEventFields,
});

// CORE:LLM_REQUEST_CANCEL
const llmRequestCancelEventFields = {
  type: z.literal("CORE:LLM_REQUEST_CANCEL"),
  data: z.object({ reason: z.string() }),
};
export const LlmRequestCancelEvent = z.object({
  ...agentCoreBaseEventFields,
  ...llmRequestCancelEventFields,
});

// CORE:LLM_INPUT_ITEM
const llmInputItemEventFields = {
  type: z.literal("CORE:LLM_INPUT_ITEM"),
  data: ResponseInputItem,
};
export const LlmInputItemEvent = z.object({
  ...agentCoreBaseEventFields,
  ...llmInputItemEventFields,
});

// CORE:LLM_OUTPUT_ITEM
const llmOutputItemEventFields = {
  type: z.literal("CORE:LLM_OUTPUT_ITEM"),
  data: ResponseOutputItem,
};
export const LlmOutputItemEvent = z.object({
  ...agentCoreBaseEventFields,
  ...llmOutputItemEventFields,
});

// CORE:SET_SYSTEM_PROMPT
const setSystemPromptEventFields = {
  type: z.literal("CORE:SET_SYSTEM_PROMPT"),
  data: z.object({ prompt: z.string() }),
};
export const SetSystemPromptEvent = z.object({
  ...agentCoreBaseEventFields,
  ...setSystemPromptEventFields,
});

// CORE:SET_MODEL_OPTS
const setModelOptsEventFields = {
  type: z.literal("CORE:SET_MODEL_OPTS"),
  data: ModelOpts,
};
export const SetModelOptsEvent = z.object({
  ...agentCoreBaseEventFields,
  ...setModelOptsEventFields,
});

// CORE:SET_METADATA
const setMetadataEventFields = {
  type: z.literal("CORE:SET_METADATA"),
  data: z.record(z.string(), JSONSerializable),
};
export const SetMetadataEvent = z.object({
  ...agentCoreBaseEventFields,
  ...setMetadataEventFields,
});

// CORE:ADD_LABEL
const addLabelEventFields = {
  type: z.literal("CORE:ADD_LABEL"),
  data: z.object({
    label: z.string().describe("Label to add to the agent's metadata"),
  }),
};
export const AddLabelEvent = z.object({
  ...agentCoreBaseEventFields,
  ...addLabelEventFields,
});

// CORE:ADD_TOOL_SPECS
const addToolSpecsEventFields = {
  type: z.literal("CORE:ADD_TOOL_SPECS"),
  data: z.object({ specs: z.array(ToolSpec) }),
};
export const AddToolSpecsEvent = z.object({
  ...agentCoreBaseEventFields,
  ...addToolSpecsEventFields,
});

const addContextRulesEventFields = {
  type: z.literal("CORE:ADD_CONTEXT_RULES"),
  data: z.object({ rules: z.array(ContextRule) }),
};
export const AddContextRulesEvent = z.object({
  ...agentCoreBaseEventFields,
  ...addContextRulesEventFields,
});
export type AddContextRulesEvent = z.infer<typeof AddContextRulesEvent>;

// CORE:REMOVE_TOOL_SPECS
const removeToolSpecsEventFields = {
  type: z.literal("CORE:REMOVE_TOOL_SPECS"),
  data: z.object({ specs: z.array(ToolSpec) }),
};
export const RemoveToolSpecsEvent = z.object({
  ...agentCoreBaseEventFields,
  ...removeToolSpecsEventFields,
});

// CORE:MESSAGE_FROM_AGENT
const messageFromAgentEventFields = {
  type: z.literal("CORE:MESSAGE_FROM_AGENT"),
  data: z.object({
    fromAgentName: z.string(),
    message: z.string(),
  }),
};
export const MessageFromAgentEvent = z.object({
  ...agentCoreBaseEventFields,
  ...messageFromAgentEventFields,
});

// CORE:INTERNAL_ERROR
const internalErrorEventFields = {
  type: z.literal("CORE:INTERNAL_ERROR"),
  data: z.object({ error: z.string(), stack: z.string().optional() }),
};
export const InternalErrorEvent = z.object({
  ...agentCoreBaseEventFields,
  ...internalErrorEventFields,
});

// CORE:LOG
const logEventFields = {
  type: z.literal("CORE:LOG"),
  data: z.object({ level: z.enum(["debug", "info", "warn", "error"]), message: z.string() }),
};
export const LogEvent = z.object({
  ...agentCoreBaseEventFields,
  ...logEventFields,
});

// CORE:INITIALIZED_WITH_EVENTS
const initializedWithEventsEventFields = {
  type: z.literal("CORE:INITIALIZED_WITH_EVENTS"),
  data: z.object({ eventCount: z.number() }),
};
export const InitializedWithEventsEvent = z.object({
  ...agentCoreBaseEventFields,
  ...initializedWithEventsEventFields,
});

// CORE:PAUSE_LLM_REQUESTS
const pauseLLMRequestsEventFields = {
  type: z.literal("CORE:PAUSE_LLM_REQUESTS"),
};
export const PauseLLMRequestsEvent = z.object({
  ...agentCoreBaseEventFields,
  ...pauseLLMRequestsEventFields,
});

// CORE:PARTICIPANT_JOINED
const participantJoinedEventFields = {
  type: z.literal("CORE:PARTICIPANT_JOINED"),
  data: z.object({
    internalUserId: z.string(),
    email: z.string().optional(),
    displayName: z.string().optional(),
    role: ParticipantRole.optional(),
    externalUserMapping: z
      .record(
        z.string(),
        z.object({
          integrationSlug: z.string(),
          externalUserId: z.string(),
          internalUserId: z.string().optional(),
          email: z.string().optional(),
          rawUserInfo: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
  }),
};
export const ParticipantJoinedEvent = z.object({
  ...agentCoreBaseEventFields,
  ...participantJoinedEventFields,
});

// CORE:PARTICIPANT_LEFT
const participantLeftEventFields = {
  type: z.literal("CORE:PARTICIPANT_LEFT"),
  data: z.object({
    internalUserId: z.string(),
  }),
};
export const ParticipantLeftEvent = z.object({
  ...agentCoreBaseEventFields,
  ...participantLeftEventFields,
});

// CORE:PARTICIPANT_MENTIONED
const participantMentionedEventFields = {
  type: z.literal("CORE:PARTICIPANT_MENTIONED"),
  data: z.object({
    internalUserId: z.string(),
    email: z.string().optional(),
    displayName: z.string().optional(),
    role: ParticipantRole.optional(),
    externalUserMapping: z
      .record(
        z.string(),
        z.object({
          integrationSlug: z.string(),
          externalUserId: z.string(),
          internalUserId: z.string().optional(),
          email: z.string().optional(),
          rawUserInfo: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .optional(),
  }),
};
export const ParticipantMentionedEvent = z.object({
  ...agentCoreBaseEventFields,
  ...participantMentionedEventFields,
});

// CORE:RESUME_LLM_REQUESTS
const resumeLLMRequestsEventFields = {
  type: z.literal("CORE:RESUME_LLM_REQUESTS"),
};
export const ResumeLLMRequestsEvent = z.object({
  ...agentCoreBaseEventFields,
  ...resumeLLMRequestsEventFields,
});

const fileSharedEventFields = {
  type: z.literal("CORE:FILE_SHARED"),
  data: z.object({
    openAIOutputItemWithoutResult: ImageGenerationCallOutput.extend({
      result: z.null(),
    }).optional(),
    direction: z.enum(["from-user-to-agent", "from-agent-to-user"]),
    iterateFileId: z.string(),
    originalFilename: z.string().optional(),
    size: z.number().optional(),
    mimeType: z.string().optional(),
    openAIFileId: z.string().optional(),
  }),
};
export const FileSharedEvent = z.object({
  ...agentCoreBaseEventFields,
  ...fileSharedEventFields,
});

// CORE:BACKGROUND_TASK_PROGRESS
const backgroundTaskProgressEventFields = {
  type: z.literal("CORE:BACKGROUND_TASK_PROGRESS"),
  data: z.object({
    processId: z.string(),
    stdout: z.string().default(""),
    stderr: z.string().default(""),
    lastSeq: z.number().optional(),
    complete: z.boolean().optional(),
  }),
};
export const BackgroundTaskProgressEvent = z.object({
  ...agentCoreBaseEventFields,
  ...backgroundTaskProgressEventFields,
});

// ------------------------- Discriminated Unions -------------------------

export const agentCoreEventSchemasUndiscriminated = [
  LocalFunctionToolCallEvent,
  ToolCallApprovalRequestedEvent,
  ToolCallApprovalEvent,
  LlmRequestStartEvent,
  LlmRequestEndEvent,
  LlmRequestCancelEvent,
  LlmInputItemEvent,
  LlmOutputItemEvent,
  SetSystemPromptEvent,
  SetMetadataEvent,
  AddLabelEvent,
  AddContextRulesEvent,
  SetModelOptsEvent,
  InternalErrorEvent,
  LogEvent,
  InitializedWithEventsEvent,
  PauseLLMRequestsEvent,
  ResumeLLMRequestsEvent,
  FileSharedEvent,
  MessageFromAgentEvent,
  ParticipantJoinedEvent,
  ParticipantLeftEvent,
  ParticipantMentionedEvent,
  BackgroundTaskProgressEvent,
] as const;

export const AgentCoreEvent = z.discriminatedUnion("type", agentCoreEventSchemasUndiscriminated);

// ---------------------------------------------------------------------------
//  Tool Spec Hash Utility
// ---------------------------------------------------------------------------

/**
 * Normalizes a tool spec by removing fields that may be added dynamically
 * during the tool conversion process. This ensures consistent hashing
 * between the original spec and the stored spec.
 */
function normalizeToolSpecForHashing(spec: ToolSpec): ToolSpec {
  if (spec.type === "agent_durable_object_tool") {
    // Create a copy without dynamically added fields
    const { overrideName, ...normalized } = spec;
    // Only keep overrideName if it was explicitly set (not the default methodName)
    if (overrideName && overrideName !== spec.methodName) {
      return { ...normalized, overrideName };
    }
    return normalized as ToolSpec;
  }
  return spec;
}

/**
 * Computes a hash of a tool spec for reliable identification.
 * Normalizes the spec first to ignore dynamically added fields.
 */
export function hashToolSpec(spec: ToolSpec): string {
  const normalized = normalizeToolSpecForHashing(spec);
  const serialized = JSON.stringify(normalized, Object.keys(normalized).sort());
  // Simple hash function - in production you might want to use a proper hash like SHA-256
  let hash = 0;
  for (let i = 0; i < serialized.length; i++) {
    const char = serialized.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36); // Convert to base36 for shorter string
}

// ---------------------------------------------------------------------------
//  Core Types
// ---------------------------------------------------------------------------

export type AgentCoreEvent = z.infer<typeof AgentCoreEvent>;

// Capital first letter event type exports
export type LocalFunctionToolCallEvent = z.infer<typeof LocalFunctionToolCallEvent>;

export type LlmRequestStartEvent = z.infer<typeof LlmRequestStartEvent>;

export type LlmRequestEndEvent = z.infer<typeof LlmRequestEndEvent>;

export type LlmRequestCancelEvent = z.infer<typeof LlmRequestCancelEvent>;

export type LlmInputItemEvent = z.infer<typeof LlmInputItemEvent>;

export type LlmOutputItemEvent = z.infer<typeof LlmOutputItemEvent>;

export type SetSystemPromptEvent = z.infer<typeof SetSystemPromptEvent>;

export type AddToolSpecsEvent = z.infer<typeof AddToolSpecsEvent>;

export type RemoveToolSpecsEvent = z.infer<typeof RemoveToolSpecsEvent>;

export type SetModelOptsEvent = z.infer<typeof SetModelOptsEvent>;

export type AddLabelEvent = z.infer<typeof AddLabelEvent>;

export type InternalErrorEvent = z.infer<typeof InternalErrorEvent>;

export type LogEvent = z.infer<typeof LogEvent>;

export type InitializedWithEventsEvent = z.infer<typeof InitializedWithEventsEvent>;

export type PauseLLMRequestsEvent = z.infer<typeof PauseLLMRequestsEvent>;

export type ResumeLLMRequestsEvent = z.infer<typeof ResumeLLMRequestsEvent>;

export type FileSharedEvent = z.infer<typeof FileSharedEvent>;
export type MessageFromAgentEvent = z.infer<typeof MessageFromAgentEvent>;

export type ParticipantJoinedEvent = z.infer<typeof ParticipantJoinedEvent>;

export type ParticipantMentionedEvent = z.infer<typeof ParticipantMentionedEvent>;

export type ToolCallApprovalState = {
  toolCallId: string;
  status: "pending" | "approved" | "rejected";
  toolName: string;
  args: unknown;
};

// ---------------------------------------------------------------------------
//  Reduced State
// ---------------------------------------------------------------------------

export interface CoreReducedState<TEventInput = AgentCoreEvent> {
  systemPrompt: string;
  inputItems: Array<
    OpenAI.Responses.ResponseInputItem & {
      /**
       * Optional function to get a sort score for the item. If not supplied, the item will be sorted by its index in the array.
       * Since this is a function, it will be dropped when serializing the input items to JSON so won't go to OpenAI.
       * The sort will happen right before sending the request to OpenAI.
       *
       * We need this because OpenAI have lots of secret rules about input item ordering. The the dreaded `Item 'fc_...' of type 'function_call' was provided without its required 'reasoning' item: 'rs_...'.` error for example.
       * we need to insert input items in the (undocumented) right order that OpenAI expects.
       *
       * If you got   [reasoning, function_call, function_call]
       * you must do  [reasoning, function_call, function_call, function_call_output, function_call_output]
       * and NOT      [reasoning, function_call, function_call_output, function_call, function_call_output]
       */
      getSortScore?: () => number;
    }
  >;
  modelOpts: ModelOpts;

  /** slug->rule. this is the source of truth for prompts, tools, and mcp servers. */
  contextRules: Record<string, ContextRule>;

  toolCallApprovals: Record<ApprovalKey, ToolCallApprovalState>;

  /**
   * These are fully valid OpenAI function tools that are ready to be used.
   * They are grouped by the source of the tool, e.g. "context-rule" or "mcp".
   * This is *partially* derived from contextRules, but also from other sources like MCP servers. Might want rethinking some day for that reason.
   */
  groupedRuntimeTools: Record<"context-rule" | "mcp", RuntimeTool<TEventInput | AgentCoreEvent>[]>;
  llmRequestStartedAtIndex: number | null;
  paused: boolean;
  /**
   * Whether an LLM request should be triggered. This is managed as reduced state
   * to allow slices to control whether their events can trigger LLM requests.
   */
  triggerLLMRequest: boolean;
  /**
   * Arbitrary key-value metadata associated with the agent conversation.
   * Consumers can store lightweight state here across events.
   */
  metadata: Record<string, JSONSerializable>;
  /**
   * Record of internal user IDs to participant information.
   * Tracks who is participating in the conversation
with the agent.
   */
  participants: Record<string, Participant>;
  /**
   * Record of internal user IDs to mentioned participant information.
   * Tracks users who have been mentioned but haven't actively participated.
   */
  mentionedParticipants: Record<string, Participant>;
}

export interface AugmentedCoreReducedState<TEventInput = AgentCoreEvent>
  extends CoreReducedState<TEventInput> {
  enabledContextRules: ContextRule[];
  /**
   * Tool specs, these are essentially "pointers" to tools that will be resolved into valid OpenAI function tools when the LLM request is made. Derived from contextRules.
   */
  toolSpecs: ToolSpec[];

  /** Flat list of runtime tools available for the agent. Derived from groupedRuntimeTools. */
  runtimeTools: RuntimeTool<TEventInput | AgentCoreEvent>[];
  /**
   * MCP servers available for this agent conversation. Derived from contextRules.
   */
  mcpServers: MCPServer[];
  /**
   * Ephemeral context items collected from the collectContextItems hook at the end of each reducer run.
   * These are reset to {} at the start of each reducer run.
   * The key is the slug of the context item. This can be used by slices such as the slack and memory
   * slices to continuously update their context item. Derived from contextRules.
   */
  ephemeralPromptFragments: Record<string, PromptFragment>;
  /** The keys on the original, un-augmented state. Can be used to get the original state without the derived props. */
  rawKeys: string[];
}

// Note: We cannot use createZodSchemaThatSatisfies for CoreReducedState because:
// 1. OpenAI.Responses.ResponseInput is not a Zod schema - it's a TypeScript type from the OpenAI SDK
// 2. The schemas imported from openai-response-schemas.ts are custom implementations that don't
//    exactly match OpenAI's official types - they're simplified/modified versions
// 3. Most schemas in this file define custom event types specific to our agent implementation,
//    not direct mappings to OpenAI types

export const CORE_INITIAL_REDUCED_STATE: CoreReducedState = {
  systemPrompt: "You are a helpful assistant",
  inputItems: [],
  modelOpts: DEFAULT_MODEL_OPTS,
  contextRules: {},
  toolCallApprovals: {},
  groupedRuntimeTools: { "context-rule": [], mcp: [] },
  llmRequestStartedAtIndex: null,
  paused: false,
  triggerLLMRequest: false,
  metadata: {},
  participants: {},
  mentionedParticipants: {},
};

export function isThinking(state: CoreReducedState): boolean {
  return state.llmRequestStartedAtIndex !== null;
}
