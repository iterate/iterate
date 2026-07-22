// Telegram Bot API access for itx.
//
// Each named Telegram connection's bot token lives in an itx secret Durable
// Object (`/secrets/integrations/telegram/{connection}/bot-token`). The Bot
// API authenticates in the URL PATH — `/bot<token>/<method>`, no header auth —
// so calls go through the project egress door with a `getSecret(...)`
// placeholder embedded in the URL; the Secret DO's URL substitution
// (domains/secrets/utils.ts) exists for exactly this shape. Token material
// never leaves the substitution pipeline and every outbound attempt lands on
// the secret's audit trail. There is NO fallback token: a missing secret
// (typo'd connection name, disconnected bot) fails loudly instead of silently
// calling with someone else's credential — same stance as slack-api.ts.

import { itxEnv } from "../../env.ts";
import { projectStub } from "../projects/egress.ts";
import { withStreamContext } from "../projects/stream-context.ts";
import { telegramBotTokenSecretPath } from "./utils.ts";
import { parseConfig } from "~/config.ts";

type TelegramBotApiResult = { description?: string; ok?: boolean; result?: unknown } & Record<
  string,
  unknown
>;

/** How to drive the Telegram built-in: a named connection, then ONE Bot API
 * method name (the API is flat — sendMessage, sendPhoto, getMe, …) with one
 * params object. Shared by the dispatch guard (rpc-targets) and __describe. */
export const TELEGRAM_CALL_GRAMMAR =
  "Use itx.integrations.telegram.get(connection?).<Bot API method>, for example itx.integrations.telegram.get().sendMessage({ chat_id, text }). Pass a connection slug only when a specific bot matters.";

/** The Bot API base for this deployment — https://api.telegram.org unless a
 * test repointed it (config.integrations.telegram.apiBaseUrl). */
export function telegramApiBaseUrl(config: { integrations: { telegram: { apiBaseUrl: string } } }) {
  return config.integrations.telegram.apiBaseUrl.replace(/\/$/, "");
}

/**
 * Telegram Bot API call authorized by one named connection's stored bot token,
 * without ever reading the token material: the request URL carries a secret
 * reference placeholder where the token goes and traverses the project egress
 * door, which substitutes it in the secret Durable Object.
 */
export async function callProjectTelegramBotApi(input: {
  body: Record<string, unknown>;
  connection: string;
  method: string;
  projectId: string;
}): Promise<TelegramBotApiResult> {
  const placeholder = `getSecret("${telegramBotTokenSecretPath(input.connection)}")`;
  const request = new Request(
    `${telegramApiBaseUrl(parseConfig(itxEnv))}/bot${placeholder}/${input.method}`,
    {
      body: JSON.stringify(input.body),
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  const response = await projectStub(itxEnv.PROJECT, input.projectId).fetch(
    withStreamContext(request, { kind: "scope", scopePath: "/" }),
  );
  if (response.status === 400 || response.status === 403 || response.status === 404) {
    // secret_not_found / secret_not_allowed_for_origin errors from the secret
    // pipeline — not a Telegram response. Name the connection so the failure
    // is actionable.
    const errorBody = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null;
    if (errorBody?.error?.startsWith("secret_")) {
      throw new Error(
        `Telegram Bot API ${input.method} failed: connection "${input.connection}" has no usable bot token secret (${errorBody.error}). Use itx.integrations.list() to see connections.`,
      );
    }
  }
  const result = (await response.json().catch(() => null)) as TelegramBotApiResult | null;
  if (result === null) {
    throw new Error(
      `Telegram Bot API ${input.method} failed: HTTP ${response.status} (non-JSON body)`,
    );
  }
  if (!response.ok || result.ok === false) {
    const error =
      typeof result.description === "string" ? result.description : `HTTP ${response.status}`;
    throw new Error(`Telegram Bot API ${input.method} failed: ${error}`);
  }
  return result;
}
