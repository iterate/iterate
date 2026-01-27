import type { CloudflareEnv } from "../../env.ts";

type ClaudeHaikuRequest = {
  system: string;
  user: string;
  maxTokens?: number;
};

type ClaudeMessageResponse = {
  content?: Array<{ type: string; text?: string }>;
};

const CLAUDE_HAIKU_MODEL = "claude-3-5-haiku-20241022";
const ANTHROPIC_VERSION = "2023-06-01";

export async function callClaudeHaiku(
  env: CloudflareEnv,
  { system, user, maxTokens = 300 }: ClaudeHaikuRequest,
): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY");
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: CLAUDE_HAIKU_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Claude request failed: ${response.status} ${message}`);
  }

  const data = (await response.json()) as ClaudeMessageResponse;
  const text = data.content?.map((item) => item.text ?? "").join("") ?? "";
  return text.trim();
}
