// Webhook payload builders shared by the integration processor suites and
// the agent-ui reducer tests: the Slack event_callback envelope (team id,
// event id headers, bot authorizations, rich-text blocks — everything the
// router and transcriber read) and the Telegram update envelope. Builders
// return plain mutable objects on purpose: edge-case tests reshape them
// (delete fields, add subtypes) rather than growing an option per mutation.

const SLACK_TEAM_ID = "T0TEAM";
/** The authorized (our) bot, as Slack reports it in `authorizations`. */
const SLACK_BOT_USER_ID = "UBOT";
const SLACK_BOT_ID = "BBOT";

export function slackHumanMessageWebhookPayload(input: {
  channel?: string;
  eventId?: string;
  /** Event type; `app_mention` deliveries override the default `message`. */
  eventType?: string;
  /** When true (default), the message @mentions the authorized bot so the
   * mention-gate wakes the LLM. Pass false for ambient channel traffic. */
  mentionBot?: boolean;
  subtype?: string;
  text?: string;
  threadTs?: string;
  ts?: string;
  user?: string;
}) {
  const mentionBot = input.mentionBot !== false;
  const defaultText = mentionBot ? `<@${SLACK_BOT_USER_ID}> hello agent` : "hello agent";
  return {
    slackTeamId: SLACK_TEAM_ID,
    headers: { slackEventId: input.eventId ?? "Ev123", slackRequestTimestamp: "1" },
    body: {
      type: "event_callback",
      // Real webhooks carry the verification secret; the transcriber must
      // strip it (asserted in the processor suites) while the router still
      // reads the rest.
      token: "verification-secret",
      team_id: SLACK_TEAM_ID,
      event_id: input.eventId ?? "Ev123",
      authorizations: [
        { is_bot: true, user_id: SLACK_BOT_USER_ID, bot_id: SLACK_BOT_ID } as Record<
          string,
          unknown
        >,
      ],
      event: {
        type: input.eventType ?? "message",
        channel: input.channel ?? "C123",
        user: input.user ?? "UHUMAN",
        text: input.text ?? defaultText,
        ts: input.ts ?? "111.222",
        blocks: [{ type: "rich_text", elements: [] }],
        ...(!input.subtype ? {} : { subtype: input.subtype }),
        ...(!input.threadTs ? {} : { thread_ts: input.threadTs }),
      } as Record<string, unknown>,
    },
  };
}

/** A bot-authored message: `bot_id` set, no `user`. Defaults to OUR bot with
 * no other bot markers (no subtype, no profile) so identity-permutation tests
 * add exactly the markers they mean to test. */
export function slackBotMessageWebhookPayload(
  input: {
    botId?: string;
    botProfile?: Record<string, unknown>;
    subtype?: string;
    text?: string;
    ts?: string;
  } = {},
) {
  const payload = slackHumanMessageWebhookPayload({
    subtype: input.subtype,
    text: input.text,
    ts: input.ts,
  });
  const event = payload.body.event;
  event.bot_id = input.botId ?? SLACK_BOT_ID;
  if (input.botProfile) event.bot_profile = input.botProfile;
  delete event.user;
  return payload;
}

const TELEGRAM_BOT_ID = "7000001";
const TELEGRAM_CHAT_ID = 42424242;

export function telegramMessageWebhookPayload(input: {
  chatId?: number;
  chatType?: string;
  date?: number;
  messageId?: number;
  replyToMessage?: Record<string, unknown>;
  text?: string;
  updateId?: number;
}) {
  return {
    botId: TELEGRAM_BOT_ID,
    body: {
      update_id: input.updateId ?? 100001,
      message: {
        message_id: input.messageId ?? 1,
        from: { id: 555, is_bot: false, first_name: "Misha", username: "misha" },
        chat: { id: input.chatId ?? TELEGRAM_CHAT_ID, type: input.chatType ?? "private" },
        date: input.date ?? 1_760_000_000,
        text: input.text ?? "hello agent",
        ...(!input.replyToMessage ? {} : { reply_to_message: input.replyToMessage }),
      } as Record<string, unknown>,
    },
  };
}
