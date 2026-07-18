import { z } from "zod";
import {
  AgentRuntime,
  ZERO_AGENT_RUNTIME,
  type AgentRuntime as AgentRuntimeRecord,
} from "@iterate-com/shared/agent-events";

export const AGENT_TITLE_MAX_LENGTH = 120;
export const AGENT_ACTIVITY_MAX_LENGTH = 240;
export const AGENT_SUMMARY_MAX_LENGTH = 600;
export const AGENT_PATH_MAX_LENGTH = 240;
export const AGENT_BINDING_CONNECTION_MAX_LENGTH = 64;
export const AGENT_BINDING_ID_MAX_LENGTH = 128;
export const AGENT_BINDING_LABEL_MAX_LENGTH = 240;
const AGENT_BINDING_REPOSITORY_PART_MAX_LENGTH = 100;
const AGENT_BINDING_SHA_MAX_LENGTH = 64;
export const AGENT_BINDING_URL_MAX_LENGTH = 512;

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

/**
 * Canonical durable identity for an agent. This is deliberately a parser, not
 * a repair step: every segment is already URL-safe and routeable, and a
 * malformed path is rejected before it can enter an agent projection.
 */
export const AgentPath = z
  .string()
  .max(AGENT_PATH_MAX_LENGTH)
  .regex(/^\/agents\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/, {
    message: 'agent path must be canonical: "/agents/" followed by lowercase [a-z0-9_-] segments',
  });
export type AgentPath = z.infer<typeof AgentPath>;

const AgentWaitingFor = z.enum(["user_input", "external_event", "timer"]);
type AgentWaitingFor = z.infer<typeof AgentWaitingFor>;

export const AgentMetadata = z.strictObject({
  title: boundedText(AGENT_TITLE_MAX_LENGTH).optional(),
  summary: boundedText(AGENT_SUMMARY_MAX_LENGTH).optional(),
  activity: boundedText(AGENT_ACTIVITY_MAX_LENGTH).optional(),
  waitingFor: AgentWaitingFor.optional(),
  pinned: z.boolean().default(false),
});
export type AgentMetadata = z.infer<typeof AgentMetadata>;

export const AgentMetadataPatch = z
  .strictObject({
    title: boundedText(AGENT_TITLE_MAX_LENGTH).nullable().optional(),
    summary: boundedText(AGENT_SUMMARY_MAX_LENGTH).nullable().optional(),
    activity: boundedText(AGENT_ACTIVITY_MAX_LENGTH).nullable().optional(),
    waitingFor: AgentWaitingFor.nullable().optional(),
    pinned: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "agent metadata patch must contain at least one property",
  });
/** A partial presentation-metadata update; null clears an optional field and omission preserves it. */
export type AgentMetadataPatch = z.infer<typeof AgentMetadataPatch>;

/** Processor-authored metadata clear guarded by the source input which woke
 * the agent. Keeping this on metadata-changed lets every metadata projection
 * apply the same race rule without subscribing to another event type. */
const AgentConditionalWaitingClear = z.strictObject({
  waitingFor: z.null(),
  clearWaitingForThroughOffset: z.number().int().positive(),
});

export const AgentMetadataChanged = z.union([AgentMetadataPatch, AgentConditionalWaitingClear]);
export type AgentMetadataChanged = z.infer<typeof AgentMetadataChanged>;

const BindingConnection = boundedText(AGENT_BINDING_CONNECTION_MAX_LENGTH);
const BindingId = boundedText(AGENT_BINDING_ID_MAX_LENGTH);
const BindingLabel = boundedText(AGENT_BINDING_LABEL_MAX_LENGTH);
const BindingRepositoryPart = boundedText(AGENT_BINDING_REPOSITORY_PART_MAX_LENGTH);
const BindingSha = boundedText(AGENT_BINDING_SHA_MAX_LENGTH);
const BindingUrl = z
  .url()
  .max(AGENT_BINDING_URL_MAX_LENGTH)
  .refine((value) => new URL(value).protocol === "https:", {
    message: "agent binding URLs must use HTTPS",
  });

export const AgentBinding = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("slack_thread"),
    connection: BindingConnection,
    channelId: BindingId,
    threadTs: BindingId,
    channelName: BindingLabel.optional(),
    url: BindingUrl.optional(),
  }),
  z.strictObject({
    type: z.literal("telegram_thread"),
    connection: BindingConnection,
    chatId: BindingId,
    messageThreadId: BindingId.optional(),
  }),
  z.strictObject({
    type: z.literal("email_thread"),
    threadId: BindingId,
    subject: BindingLabel.optional(),
    counterpart: BindingLabel.optional(),
  }),
  z.strictObject({
    type: z.literal("github_pull_request"),
    connection: BindingConnection,
    installationId: BindingId,
    owner: BindingRepositoryPart,
    repo: BindingRepositoryPart,
    number: z.number().int().positive(),
    url: BindingUrl.optional(),
  }),
  z.strictObject({
    type: z.literal("github_check_run"),
    connection: BindingConnection,
    installationId: BindingId,
    owner: BindingRepositoryPart,
    repo: BindingRepositoryPart,
    number: z.number().int().positive(),
    checkRunId: z.number().int().positive().optional(),
    headSha: BindingSha.optional(),
    url: BindingUrl.optional(),
  }),
]);
export type AgentBinding = z.infer<typeof AgentBinding>;

const AgentCatalogTimestamps = z.strictObject({
  createdAt: z.iso.datetime(),
  lastWorkAt: z.iso.datetime(),
  metadataUpdatedAt: z.iso.datetime().optional(),
  activityUpdatedAt: z.iso.datetime().optional(),
});
type AgentCatalogTimestamps = z.infer<typeof AgentCatalogTimestamps>;

/** One entry in the collection processor's durable agent database. Every
 * field is reducible from the collection's deliberately narrow created +
 * metadata event subscription. */
export const AgentCatalogRecord = z.strictObject({
  path: AgentPath,
  metadata: AgentMetadata,
  timestamps: AgentCatalogTimestamps,
});
export type AgentCatalogRecord = z.infer<typeof AgentCatalogRecord>;

const AgentPresentationTimestamps = AgentCatalogTimestamps.extend({
  runtimeUpdatedAt: z.iso.datetime().optional(),
});

/** Optional presentation overlays accepted by the shared agent UI. The
 * collection itself returns AgentCatalogRecord; consumers may enrich those
 * records from other live-state surfaces without widening the database
 * schema. */
export const AgentRecord = AgentCatalogRecord.extend({
  runtime: AgentRuntime.optional(),
  binding: AgentBinding.optional(),
  timestamps: AgentPresentationTimestamps,
});
export type AgentRecord = z.infer<typeof AgentRecord>;

/** Normalize optional untrusted display text before emitting a bounded
 * binding fact. Identifiers remain strict and are rejected rather than
 * rewritten; labels may be safely clipped because they are presentation-only
 * copies of the canonical external thread. */
export function normalizeAgentBindingLabel(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return undefined;
  return normalized.slice(0, AGENT_BINDING_LABEL_MAX_LENGTH);
}

export type AgentDisplayState =
  | "running_code"
  | "waiting_for_model"
  | "queued"
  | "waiting_for_user_input"
  | "waiting_for_external_event"
  | "waiting_for_timer"
  | "idle";

export function applyAgentMetadataPatch(
  metadata: AgentMetadata,
  patch: AgentMetadataPatch,
): AgentMetadata {
  const next = { ...metadata };
  let changed = false;

  for (const key of ["title", "summary", "activity", "waitingFor"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) {
      if (next[key] !== undefined) {
        delete next[key];
        changed = true;
      }
      continue;
    }
    if (next[key] !== value) {
      Object.assign(next, { [key]: value });
      changed = true;
    }
  }

  if (patch.pinned !== undefined && next.pinned !== patch.pinned) {
    next.pinned = patch.pinned;
    changed = true;
  }

  return changed ? next : metadata;
}

type AgentRuntimeSource = {
  activeScriptExecutionIds: readonly string[];
  context: { system: readonly { key?: string }[] };
  currentRequest: null | { phase: "scheduled" | "requested" };
  llmRequests: Record<string, { status: "requested" | "started" }>;
  pendingTriggerOffset: number | null;
};

export function deriveAgentRuntime(
  state: AgentRuntimeSource,
  systemPromptContextKey: string,
): AgentRuntimeRecord {
  const pending = state.pendingTriggerOffset === null ? 0 : 1;
  const runnable =
    pending === 1 && state.context.system.some((item) => item.key === systemPromptContextKey)
      ? 1
      : 0;
  let requested = 0;
  let started = 0;
  for (const request of Object.values(state.llmRequests)) {
    if (request.status === "requested") requested += 1;
    else started += 1;
  }
  return {
    triggers: { pending, runnable },
    llmRequests: {
      scheduled: state.currentRequest?.phase === "scheduled" ? 1 : 0,
      requested,
      started,
    },
    runningScripts: state.activeScriptExecutionIds.length,
  };
}

export function deriveAgentDisplayState(
  runtime: AgentRuntimeRecord | undefined,
  waitingFor?: AgentWaitingFor,
): AgentDisplayState {
  const current = runtime ?? ZERO_AGENT_RUNTIME;
  if (current.runningScripts > 0) return "running_code";
  if (current.llmRequests.requested > 0 || current.llmRequests.started > 0) {
    return "waiting_for_model";
  }
  if (current.llmRequests.scheduled > 0 || current.triggers.runnable > 0) return "queued";
  if (waitingFor === "user_input") return "waiting_for_user_input";
  if (waitingFor === "external_event") return "waiting_for_external_event";
  if (waitingFor === "timer") return "waiting_for_timer";
  return "idle";
}
