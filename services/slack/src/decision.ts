import {
  SlackWebhookReceivedPayload as SlackWebhookReceivedPayloadSchema,
  type SlackWebhookReceivedPayload,
} from "../../../packages/shared/src/jonasland/agents-events.ts";

interface SlackRouteRecord {
  channel: string;
  threadTs: string;
  agentPath: string;
  providerSessionId: string;
  agentStreamPath: string;
}

type AgentProvider = "opencode" | "pi";

export interface SlackWebhookDecisionInput {
  webhook: SlackWebhookReceivedPayload;
  existingRoutes: Array<SlackRouteRecord>;
  provider: AgentProvider;
}

export interface SlackWebhookDecision {
  shouldCreateAgent: boolean;
  shouldAppendPrompt: boolean;
  getOrCreateInput?: { agentPath: string; provider: AgentProvider };
  reasonCodes: string[];
  debug: Record<string, unknown>;
}

const IGNORED_SUBTYPES = new Set(["message_changed", "message_deleted", "bot_message"]);

function sanitizeSegment(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function buildSlackAgentPath(input: { channel: string; threadTs: string }): string {
  const channel = sanitizeSegment(input.channel);
  const thread = sanitizeSegment(input.threadTs.replace(/\./g, "-"));
  return `/agents/slack/${channel}/${thread}`;
}

export function decideSlackWebhook(input: SlackWebhookDecisionInput): SlackWebhookDecision {
  const text = input.webhook.text.trim();
  const existingRouteCount = input.existingRoutes.length;
  const proposedAgentPath = buildSlackAgentPath({
    channel: input.webhook.channel,
    threadTs: input.webhook.threadTs,
  });

  if (text.length === 0) {
    return {
      shouldCreateAgent: false,
      shouldAppendPrompt: false,
      reasonCodes: ["message.empty"],
      debug: {
        existingRouteCount,
        proposedAgentPath,
        ignoredSubtype: input.webhook.subtype ?? null,
      },
    };
  }

  if (input.webhook.subtype && IGNORED_SUBTYPES.has(input.webhook.subtype)) {
    return {
      shouldCreateAgent: false,
      shouldAppendPrompt: false,
      reasonCodes: ["message.ignored-subtype"],
      debug: {
        subtype: input.webhook.subtype,
        existingRouteCount,
        proposedAgentPath,
      },
    };
  }

  if (existingRouteCount > 0) {
    return {
      shouldCreateAgent: false,
      shouldAppendPrompt: true,
      reasonCodes: ["route.matched-existing"],
      debug: {
        existingRouteCount,
        proposedAgentPath,
        matchedAgentPaths: input.existingRoutes.map((route) => route.agentPath),
      },
    };
  }

  return {
    shouldCreateAgent: true,
    shouldAppendPrompt: true,
    getOrCreateInput: {
      agentPath: proposedAgentPath,
      provider: input.provider,
    },
    reasonCodes: ["route.missing-create-agent"],
    debug: {
      existingRouteCount,
      proposedAgentPath,
      provider: input.provider,
      channel: input.webhook.channel,
      threadTs: input.webhook.threadTs,
    },
  };
}

export function normalizeSlackWebhookInput(rawInput: unknown):
  | {
      ok: true;
      event: SlackWebhookReceivedPayload;
    }
  | {
      ok: false;
      error: string;
      debug: Record<string, unknown>;
    } {
  const body = rawInput as {
    event?: {
      text?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      type?: string;
      user?: string;
    };
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    type?: string;
    user?: string;
  };

  const eventBody = body.event ?? body;
  const threadTs = eventBody.thread_ts ?? eventBody.ts;
  const channel = eventBody.channel;
  const text = eventBody.text ?? "";

  if (!threadTs || !channel) {
    return {
      ok: false,
      error: "thread_ts/ts and channel are required",
      debug: {
        hasThreadTs: Boolean(threadTs),
        hasChannel: Boolean(channel),
      },
    };
  }

  const normalized = {
    source: "slack" as const,
    channel,
    threadTs,
    ts: eventBody.ts ?? threadTs,
    user: eventBody.user,
    subtype: eventBody.type,
    text,
    receivedAt: new Date().toISOString(),
  };

  const parsed = SlackWebhookReceivedPayloadSchema.safeParse(normalized);
  if (!parsed.success) {
    return {
      ok: false,
      error: "invalid Slack webhook payload",
      debug: {
        issues: parsed.error.issues,
      },
    };
  }

  return {
    ok: true,
    event: parsed.data,
  };
}
