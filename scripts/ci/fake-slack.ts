import { WebAPIPlatformError, type WebClient } from "@slack/web-api";
import { slackChannelIds } from "./slack.ts";

/** A message's Slack metadata: an event type and its payload. */
type Metadata = { event_type: string; event_payload: Record<string, unknown> };

/** A message as the fake keeps it: top-level, with its thread's replies; a reply names its thread
 *  and whether it was sent to the channel too. With `updateError`, Slack answers that error to
 *  every edit of it. */
export type FakeMessage = {
  ts: string;
  text: string;
  bot_id: string;
  thread_ts?: string;
  reply_broadcast?: boolean;
  metadata?: Metadata;
  updateError?: string;
  replies: FakeMessage[];
};

type Channel = keyof typeof slackChannelIds;

/** The emoji Slack's history spells as :shortcodes:, as the posters' messages use them. */
const SHORTCODES: Record<string, string> = {
  "🚨": ":rotating_light:",
  "✅": ":white_check_mark:",
  "🚀": ":rocket:",
  "🧪": ":test_tube:",
  "🔴": ":red_circle:",
};

/**
 * Slack's Web API as the CI posters call it, answering from memory: auth.test, chat.postMessage (a
 * thread reply with `thread_ts`, sent to the channel too with `reply_broadcast`), chat.update,
 * chat.delete, conversations.history (a channel's messages and its broadcast replies, each page
 * newest first, `limit` a page, with next_cursor; given `oldest`, the first page is the window's
 * oldest, as Slack's is) and conversations.replies. A post or edit may carry `metadata`, which the
 * reads return only when asked `include_all_metadata`, as Slack's do. History spells the posters'
 * emoji as Slack's does. Every call is recorded in `calls`. A message's ts is `clock.now` in seconds plus a
 * counter, so messages keep their order. Slack's errors are its client's: an edit or delete of a
 * message that is not there answers `message_not_found`, and an edit of one with `updateError`
 * answers that.
 */
export function fakeSlack(options: { now: number }) {
  const channels = new Map<string, FakeMessage[]>(
    Object.values(slackChannelIds).map((id) => [id, []]),
  );
  const calls: {
    method: string;
    channel?: string;
    ts?: string;
    text?: string;
    thread_ts?: string;
    reply_broadcast?: boolean;
    metadata?: Metadata;
  }[] = [];
  const clock = { now: options.now };
  let counter = 0;
  const nextTs = (ageHours = 0) =>
    (clock.now / 1000 - ageHours * 3600 + ++counter / 10_000).toFixed(6);
  const slackError = (error: string) => new WebAPIPlatformError({ ok: false, error });
  const messages = (channel: string) => {
    const list = channels.get(channel);
    if (!list) throw new Error(`the fake has no channel ${channel}`);
    return list;
  };
  const timeline = (channel: string) =>
    messages(channel)
      .flatMap((message) => [message, ...message.replies])
      .sort((a, b) => Number(a.ts) - Number(b.ts));
  const find = (channel: string, ts: string) => {
    const found = timeline(channel).find((message) => message.ts === ts);
    if (!found) throw slackError("message_not_found");
    return found;
  };
  const asHistory =
    (withMetadata: boolean | undefined) =>
    ({ replies: _, updateError: __, metadata, ...message }: FakeMessage) => ({
      ...message,
      ...(withMetadata && metadata && { metadata: structuredClone(metadata) }),
      text: Object.entries(SHORTCODES).reduce(
        (text, [emoji, code]) => text.replaceAll(emoji, code),
        message.text,
      ),
    });

  const client = {
    auth: { test: async () => ({ ok: true, bot_id: "B0CIBOT" }) },
    chat: {
      postMessage: async (args: {
        channel: string;
        text: string;
        thread_ts?: string;
        reply_broadcast?: boolean;
        metadata?: Metadata;
      }) => {
        calls.push({ method: "chat.postMessage", ...args });
        const message: FakeMessage = {
          ts: nextTs(),
          text: args.text,
          bot_id: "B0CIBOT",
          thread_ts: args.thread_ts,
          reply_broadcast: args.reply_broadcast,
          metadata: args.metadata && structuredClone(args.metadata),
          replies: [],
        };
        if (args.thread_ts) find(args.channel, args.thread_ts).replies.push(message);
        else messages(args.channel).push(message);
        return { ok: true, ts: message.ts };
      },
      update: async (args: { channel: string; ts: string; text: string; metadata?: Metadata }) => {
        calls.push({ method: "chat.update", ...args });
        const message = find(args.channel, args.ts);
        if (message.updateError) throw slackError(message.updateError);
        message.text = args.text;
        if (args.metadata) message.metadata = structuredClone(args.metadata);
        return { ok: true, ts: args.ts };
      },
      delete: async (args: { channel: string; ts: string }) => {
        calls.push({ method: "chat.delete", ...args });
        const message = find(args.channel, args.ts);
        const list = message.thread_ts
          ? find(args.channel, message.thread_ts).replies
          : messages(args.channel);
        list.splice(list.indexOf(message), 1);
        return { ok: true };
      },
    },
    conversations: {
      history: async (args: {
        channel: string;
        oldest?: string;
        limit?: number;
        cursor?: string;
        include_all_metadata?: boolean;
      }) => {
        calls.push({ method: "conversations.history", channel: args.channel });
        // given `oldest` (and no `latest`), Slack pages from the window's oldest end
        const fromOldest = Boolean(args.oldest);
        const ordered = timeline(args.channel)
          .filter((message) => !message.thread_ts || message.reply_broadcast)
          .filter((message) => Number(message.ts) >= Number(args.oldest || 0))
          .sort((a, b) => (fromOldest ? Number(a.ts) - Number(b.ts) : Number(b.ts) - Number(a.ts)));
        const start = Number(args.cursor || 0);
        const end = start + (args.limit || 100);
        const page = ordered.slice(start, end);
        return {
          ok: true,
          messages: (fromOldest ? page.reverse() : page).map(asHistory(args.include_all_metadata)),
          response_metadata: { next_cursor: end < ordered.length ? String(end) : "" },
        };
      },
      replies: async (args: { channel: string; ts: string; include_all_metadata?: boolean }) => {
        calls.push({ method: "conversations.replies", channel: args.channel });
        const parent = find(args.channel, args.ts);
        return {
          ok: true,
          messages: [parent, ...parent.replies].map(asHistory(args.include_all_metadata)),
        };
      },
    },
  } as unknown as WebClient; // the calls the CI posters make, not the whole client

  return {
    client,
    calls,
    /** The time new messages are stamped with, in milliseconds: set it to run the posters later. */
    clock,
    /** A channel's top-level messages, oldest first, as posted. */
    channel: (name: Channel) =>
      [...messages(slackChannelIds[name])].sort((a, b) => Number(a.ts) - Number(b.ts)),
    /** A channel's messages with their thread replies, oldest first. */
    timeline: (name: Channel) => timeline(slackChannelIds[name]),
    /** Puts a message in a channel, or in `thread`'s thread, as if a bot, this one unless `botId`
     *  says, had posted it `ageHours` ago, and Slack answered `updateError` to its edits. */
    seed: (
      name: Channel,
      text: string,
      {
        ageHours = 0,
        botId = "B0CIBOT",
        thread,
        updateError,
      }: { ageHours?: number; botId?: string; thread?: FakeMessage; updateError?: string } = {},
    ) => {
      const seeded: FakeMessage = {
        ts: nextTs(ageHours),
        text,
        bot_id: botId,
        thread_ts: thread?.ts,
        updateError,
        replies: [],
      };
      if (thread) thread.replies.push(seeded);
      else messages(slackChannelIds[name]).push(seeded);
      return seeded;
    },
  };
}
