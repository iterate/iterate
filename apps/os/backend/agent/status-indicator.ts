import jsonata from "jsonata/sync";
import { logger } from "../tag-logger.ts";

export type StatusIndicatorTemplateContext = Record<string, unknown>;

function renderStatusIndicatorTemplate(template: string, context: StatusIndicatorTemplateContext) {
  if (!template.includes("${")) return template;

  return template.replace(/\$\{([^}]+)\}/g, (_match, expression) => {
    const trimmedExpression = typeof expression === "string" ? expression.trim() : "";
    if (!trimmedExpression) {
      return "";
    }

    try {
      const evaluator = jsonata(trimmedExpression);
      const result = evaluator.evaluate(context);
      if (result === undefined || result === null) {
        return "";
      }
      return typeof result === "string" ? result : JSON.stringify(result);
    } catch (error) {
      logger.debug("[SlackAgent] Failed to evaluate statusIndicatorText expression", {
        expression: trimmedExpression,
        error,
      });
      return "";
    }
  });
}

function parseArguments(argsJson: unknown): Record<string, unknown> {
  if (argsJson === null || argsJson === undefined) {
    return {};
  }

  if (typeof argsJson === "string") {
    try {
      if (!argsJson.trim()) {
        return {};
      }
      return JSON.parse(argsJson) as Record<string, unknown>;
    } catch (error) {
      logger.debug("[SlackAgent] Failed to parse tool call arguments for statusIndicatorText", {
        arguments: argsJson,
        error,
      });
      return {};
    }
  }

  if (typeof argsJson === "object") {
    return argsJson as Record<string, unknown>;
  }

  return {};
}

export function resolveStatusIndicatorText(params: {
  toolName: string;
  statusIndicatorText?: string;
  argsJson?: unknown;
  templateContext?: StatusIndicatorTemplateContext;
}): string {
  const { toolName, statusIndicatorText, argsJson, templateContext } = params;

  if (!statusIndicatorText) {
    return `🛠️ ${toolName}...`;
  }

  const context: StatusIndicatorTemplateContext = {
    toolName,
    args: parseArguments(argsJson),
    ...(templateContext ?? {}),
  };

  return renderStatusIndicatorTemplate(statusIndicatorText, context);
}

/**
 * Slack's assistant status endpoint accepts both a human-style typing indicator and
 * a list of "loading messages" that shimmer in the thread while the bot is thinking.
 *
 * We keep the public-facing message (with emoji) separate from the typing indicator
 * so the classic "is typing..." experience still feels natural to humans. Emojis look
 * odd inside the typing indicator, so we translate the public status text into
 * simplified wording while recycling the original status for the loading messages.
 */
export function buildSlackThreadStatusPayload(status: string | null | undefined): {
  status: string;
  loading_messages?: string[];
} {
  if (!status) {
    return { status: "" };
  }

  const payload = {
    status: status === "✏️ writing response" ? "is typing..." : "is thinking...",
    loading_messages: [`${status}...`],
  } as const;

  return { ...payload };
}

