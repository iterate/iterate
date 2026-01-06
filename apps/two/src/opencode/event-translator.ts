import type {
  Event,
  EventMessagePartUpdated,
  EventMessageUpdated,
  EventSessionCreated,
  EventSessionDeleted,
  EventSessionStatus,
  EventSessionUpdated,
  EventPermissionUpdated,
  Part,
  TextPart,
  ToolPart,
  ReasoningPart,
} from "@opencode-ai/sdk";
import type { AgentEventInput } from "../schemas/events.ts";

export type TranslatedEvent = AgentEventInput & {
  sessionId: string;
};

export function translateOpenCodeEvent(event: Event): TranslatedEvent | null {
  switch (event.type) {
    case "session.created":
      return translateSessionCreated(event);
    case "session.updated":
      return translateSessionUpdated(event);
    case "session.deleted":
      return translateSessionDeleted(event);
    case "session.status":
      return translateSessionStatus(event);
    case "message.updated":
      return translateMessageUpdated(event);
    case "message.part.updated":
      return translateMessagePartUpdated(event);
    case "permission.updated":
      return translatePermissionUpdated(event);
    default:
      return null;
  }
}

function translateSessionCreated(event: EventSessionCreated): TranslatedEvent {
  return {
    sessionId: event.properties.info.id,
    type: "opencode:session_created",
    payload: {
      sessionId: event.properties.info.id,
      title: event.properties.info.title,
      directory: event.properties.info.directory,
    },
  };
}

function translateSessionUpdated(event: EventSessionUpdated): TranslatedEvent {
  return {
    sessionId: event.properties.info.id,
    type: "opencode:session_updated",
    payload: {
      sessionId: event.properties.info.id,
      title: event.properties.info.title,
      summary: event.properties.info.summary,
      share: event.properties.info.share,
    },
  };
}

function translateSessionDeleted(event: EventSessionDeleted): TranslatedEvent {
  return {
    sessionId: event.properties.info.id,
    type: "opencode:session_deleted",
    payload: {
      sessionId: event.properties.info.id,
    },
  };
}

function translateSessionStatus(event: EventSessionStatus): TranslatedEvent {
  return {
    sessionId: event.properties.sessionID,
    type: "opencode:session_status",
    payload: {
      sessionId: event.properties.sessionID,
      status: event.properties.status,
    },
  };
}

function translateMessageUpdated(event: EventMessageUpdated): TranslatedEvent {
  const message = event.properties.info;
  return {
    sessionId: message.sessionID,
    type: "opencode:message_updated",
    payload: {
      messageId: message.id,
      sessionId: message.sessionID,
      role: message.role,
      ...(message.role === "assistant" && {
        cost: message.cost,
        tokens: message.tokens,
        modelId: message.modelID,
        providerId: message.providerID,
        error: message.error,
        finish: message.finish,
      }),
    },
  };
}

function translateMessagePartUpdated(event: EventMessagePartUpdated): TranslatedEvent {
  const part = event.properties.part;
  const delta = event.properties.delta;

  return {
    sessionId: part.sessionID,
    type: getPartEventType(part),
    payload: {
      partId: part.id,
      messageId: part.messageID,
      sessionId: part.sessionID,
      partType: part.type,
      delta,
      ...getPartSpecificPayload(part),
    },
  };
}

function getPartEventType(part: Part): string {
  switch (part.type) {
    case "text":
      return "opencode:text";
    case "reasoning":
      return "opencode:reasoning";
    case "tool":
      return `opencode:tool_${part.state.status}`;
    case "step-start":
      return "opencode:step_start";
    case "step-finish":
      return "opencode:step_finish";
    case "file":
      return "opencode:file";
    case "agent":
      return "opencode:agent";
    case "subtask":
      return "opencode:subtask";
    default:
      return `opencode:part_${part.type}`;
  }
}

function getPartSpecificPayload(part: Part): Record<string, unknown> {
  switch (part.type) {
    case "text":
      return {
        text: (part as TextPart).text,
        synthetic: (part as TextPart).synthetic,
      };
    case "reasoning":
      return {
        text: (part as ReasoningPart).text,
      };
    case "tool": {
      const toolPart = part as ToolPart;
      return {
        tool: toolPart.tool,
        callId: toolPart.callID,
        state: toolPart.state,
      };
    }
    case "step-start":
      return {
        snapshot: part.snapshot,
      };
    case "step-finish":
      return {
        reason: part.reason,
        cost: part.cost,
        tokens: part.tokens,
      };
    case "file":
      return {
        mime: part.mime,
        filename: part.filename,
        url: part.url,
      };
    case "agent":
      return {
        name: part.name,
      };
    case "subtask":
      return {
        prompt: part.prompt,
        description: part.description,
        agent: part.agent,
      };
    default:
      return {};
  }
}

function translatePermissionUpdated(event: EventPermissionUpdated): TranslatedEvent {
  const permission = event.properties;
  return {
    sessionId: permission.sessionID,
    type: "opencode:permission_request",
    payload: {
      permissionId: permission.id,
      permissionType: permission.type,
      sessionId: permission.sessionID,
      messageId: permission.messageID,
      title: permission.title,
      pattern: permission.pattern,
      metadata: permission.metadata,
    },
  };
}
