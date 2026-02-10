import { inspect } from "node:util";
import * as Discord from "discord.js";
import * as OpenCode from "@opencode-ai/sdk/v2";

export function formatToolCallSummary(part: OpenCode.ToolPart) {
  const emoji = resolveToolEmoji(part.tool);
  const args = formatKeyValuePairs(part.state.input, 2);
  if (part.state.status === "error" && part.state.error) {
    args.push(`error=${formatInlineValue(part.state.error, 2)}`);
  }
  const body = args.length ? "\n" + Discord.codeBlock(args.join(", ")) : "";
  return `**Tool:** ${emoji} ${part.tool}${body}`;
}

function formatKeyValuePairs(value: unknown, depth = 2) {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).map(
    ([key, item]) => `${key}=${formatInlineValue(item, depth)}`,
  );
}

function formatInlineValue(value: unknown, depth = 2): string {
  if (value == null) return "null";
  if (typeof value === "string") {
    const trimmed = value.split("\n")[0] ?? "";
    return truncateInline(trimmed, 200);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.map((item) => formatInlineValue(item, depth - 1));
    return `[${items.join(", ")}]`;
  }
  if (typeof value === "object") {
    return inspect(value, { depth: Math.max(0, depth - 1), breakLength: Infinity, compact: true });
  }
  return truncateInline(String(value), 200);
}

function truncateInline(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

const TOOL_EMOJI_MAP: Array<[RegExp, string]> = [
  [/\b(read)\b/, "📚"],
  [/\b(write)\b/, "✏️"],
  [/\b(patch)\b/, "🩹"],
  [/\b(bash)\b/, "⚙️"],
  [/\b(grep|glob)\b/, "🔍"],
];

function resolveToolEmoji(toolId: string) {
  const normalized = toolId.toLowerCase();
  for (const [pattern, emoji] of TOOL_EMOJI_MAP) {
    if (pattern.test(normalized)) return emoji;
  }
  return "🛠️";
}
