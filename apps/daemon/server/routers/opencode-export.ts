// Extracted from opencode history (commit https://github.com/anomalyco/opencode/commit/05eee679a) and made standalone.

export type TranscriptOptions = {
  thinking?: boolean;
  toolDetails?: boolean;
  assistantMetadata?: boolean;
};

export type SessionInfo = {
  id: string;
  title: string;
  time: {
    created: number;
    updated: number;
  };
};

export type UserMessage = {
  role: "user";
};

export type AssistantMessage = {
  role: "assistant";
  agent: string;
  modelID: string;
  time: {
    created?: number;
    completed?: number;
  };
};

export type TextPart = {
  type: "text";
  text: string;
  synthetic?: boolean;
};

export type ReasoningPart = {
  type: "reasoning";
  text: string;
};

export type ToolPart = {
  type: "tool";
  tool: string;
  state: {
    status: "running" | "completed" | "error";
    input?: unknown;
    output?: unknown;
    error?: unknown;
  };
};

export type Part = TextPart | ReasoningPart | ToolPart;

export type MessageWithParts = {
  info: UserMessage | AssistantMessage;
  parts: Part[];
};

export function formatTranscript(
  session: SessionInfo,
  messages: MessageWithParts[],
  options: TranscriptOptions,
): string {
  const header = [
    `# ${session.title}`,
    "",
    `**Session ID:** ${session.id}`,
    `**Created:** ${new Date(session.time.created).toLocaleString()}`,
    `**Updated:** ${new Date(session.time.updated).toLocaleString()}`,
    "",
    "---",
    "",
  ].join("\n");

  const body = messages
    .map((msg) => `${formatMessage(msg.info, msg.parts, options)}---\n\n`)
    .join("");

  return `${header}${body}`;
}

export function formatMessage(
  msg: UserMessage | AssistantMessage,
  parts: Part[],
  options: TranscriptOptions,
): string {
  const head =
    msg.role === "user" ? "## User\n\n" : formatAssistantHeader(msg, options.assistantMetadata);
  const body = parts.map((part) => formatPart(part, options)).join("");
  return `${head}${body}`;
}

export function formatAssistantHeader(
  msg: AssistantMessage,
  includeMetadata: boolean | undefined,
): string {
  if (!includeMetadata) return "## Assistant\n\n";

  const duration =
    msg.time.completed && msg.time.created
      ? `${((msg.time.completed - msg.time.created) / 1000).toFixed(1)}s`
      : "";
  const meta = duration
    ? ` (${titlecase(msg.agent)} · ${msg.modelID} · ${duration})`
    : ` (${titlecase(msg.agent)} · ${msg.modelID})`;

  return `## Assistant${meta}\n\n`;
}

export function formatPart(part: Part, options: TranscriptOptions): string {
  if (part.type === "text" && !part.synthetic) return `${part.text}\n\n`;

  if (part.type === "reasoning") {
    if (!options.thinking) return "";
    return `_Thinking:_\n\n${part.text}\n\n`;
  }

  if (part.type !== "tool") return "";

  const chunks = [`\`\`\`\nTool: ${part.tool}\n`];

  if (options.toolDetails && part.state.input !== undefined) {
    chunks.push(`\n**Input:**\n\`\`\`json\n${JSON.stringify(part.state.input, null, 2)}\n\`\`\``);
  }
  if (options.toolDetails && part.state.status === "completed" && part.state.output !== undefined) {
    chunks.push(`\n**Output:**\n\`\`\`\n${toText(part.state.output)}\n\`\`\``);
  }
  if (options.toolDetails && part.state.status === "error" && part.state.error !== undefined) {
    chunks.push(`\n**Error:**\n\`\`\`\n${toText(part.state.error)}\n\`\`\``);
  }

  chunks.push("\n```\n\n");
  return chunks.join("");
}

function titlecase(text: string): string {
  if (!text) return text;
  return text[0].toUpperCase() + text.slice(1);
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}
