import type { WebClient } from "@slack/web-api";
import { slackChannelIds } from "./slack.ts";

/** A message as the fake keeps it: top-level, with its thread's replies. */
export type FakeMessage = { ts: string; text: string; bot_id: string; replies: FakeMessage[] };

type Channel = keyof typeof slackChannelIds;

/** The emoji Slack's history spells as :shortcodes:, as the posters' messages use them. */
const SHORTCODES: Record<string, string> = {
  "🚨": ":rotating_light:",
  "✅": ":white_check_mark:",
  "🚀": ":rocket:",
  "🧪": ":test_tube:",
};

/**
 * Slack's Web API as the CI posters call it, answering from memory: auth.test, chat.postMessage (a
 * thread reply with `thread_ts`), chat.update, chat.delete, conversations.history (each page newest
 * first, `limit` a page, with next_cursor; given `oldest` without `latest`, the first page is the
 * window's oldest, as Slack's is) and conversations.replies. History spells the posters' emoji as
 * Slack's does. Every call is recorded in `calls`. A message's ts is a second before `now` plus a
 * counter, so messages keep their order and none is newer than a read at `now`. With
 * `failUpdates`, every chat.update is refused after it is recorded, as Slack answers an error.
 */
export function fakeSlack(options: { now: number; failUpdates?: boolean }) {
  const channels = new Map<string, FakeMessage[]>(
    Object.values(slackChannelIds).map((id) => [id, []]),
  );
  const calls: {
    method: string;
    channel?: string;
    ts?: string;
    text?: string;
    thread_ts?: string;
  }[] = [];
  let counter = 0;
  const nextTs = (ageHours = 0) =>
    (options.now / 1000 - ageHours * 3600 - 1 + ++counter / 10_000).toFixed(6);
  const messages = (channel: string) => {
    const list = channels.get(channel);
    if (!list) throw new Error(`the fake has no channel ${channel}`);
    return list;
  };
  const find = (channel: string, ts: string) => {
    for (const message of messages(channel)) {
      if (message.ts === ts) return message;
      const reply = message.replies.find((candidate) => candidate.ts === ts);
      if (reply) return reply;
    }
    throw new Error(`the fake has no message ${ts} in ${channel}`);
  };
  const asHistory = ({ replies: _, ...message }: FakeMessage) => ({
    ...message,
    text: Object.entries(SHORTCODES).reduce(
      (text, [emoji, code]) => text.replaceAll(emoji, code),
      message.text,
    ),
  });

  const client = {
    auth: { test: async () => ({ ok: true, bot_id: "B0CIBOT" }) },
    chat: {
      postMessage: async (args: { channel: string; text: string; thread_ts?: string }) => {
        calls.push({ method: "chat.postMessage", ...args });
        const message: FakeMessage = {
          ts: nextTs(),
          text: args.text,
          bot_id: "B0CIBOT",
          replies: [],
        };
        if (args.thread_ts) find(args.channel, args.thread_ts).replies.push(message);
        else messages(args.channel).push(message);
        return { ok: true, ts: message.ts };
      },
      update: async (args: { channel: string; ts: string; text: string }) => {
        calls.push({ method: "chat.update", ...args });
        if (options.failUpdates) throw new Error("an_error");
        find(args.channel, args.ts).text = args.text;
        return { ok: true, ts: args.ts };
      },
      delete: async (args: { channel: string; ts: string }) => {
        calls.push({ method: "chat.delete", ...args });
        const list = messages(args.channel);
        list.splice(
          list.findIndex((message) => message.ts === args.ts),
          1,
        );
        return { ok: true };
      },
    },
    conversations: {
      history: async (args: {
        channel: string;
        oldest?: string;
        latest?: string;
        limit?: number;
        cursor?: string;
      }) => {
        calls.push({ method: "conversations.history", channel: args.channel });
        const inWindow = messages(args.channel).filter(
          (message) =>
            Number(message.ts) >= Number(args.oldest || 0) &&
            Number(message.ts) <= Number(args.latest || Infinity),
        );
        // Slack pages from the window's oldest end when `oldest` comes without `latest`
        const fromOldest = Boolean(args.oldest) && !args.latest;
        const ordered = inWindow.sort((a, b) =>
          fromOldest ? Number(a.ts) - Number(b.ts) : Number(b.ts) - Number(a.ts),
        );
        const start = Number(args.cursor || 0);
        const end = start + (args.limit || 100);
        const page = ordered.slice(start, end);
        return {
          ok: true,
          messages: (fromOldest ? page.reverse() : page).map(asHistory),
          response_metadata: { next_cursor: end < ordered.length ? String(end) : "" },
        };
      },
      replies: async (args: { channel: string; ts: string }) => {
        calls.push({ method: "conversations.replies", channel: args.channel });
        const parent = find(args.channel, args.ts);
        return { ok: true, messages: [parent, ...parent.replies].map(asHistory) };
      },
    },
  } as unknown as WebClient;

  return {
    client,
    calls,
    /** A channel's top-level messages, oldest first, as posted. */
    channel: (name: Channel) =>
      [...messages(slackChannelIds[name])].sort((a, b) => Number(a.ts) - Number(b.ts)),
    /** Puts a message in a channel as if a bot, this one unless `botId` says, had posted it
     *  `ageHours` ago. */
    seed: (
      name: Channel,
      text: string,
      { ageHours = 0, botId = "B0CIBOT" }: { ageHours?: number; botId?: string } = {},
    ) => {
      const seeded: FakeMessage = { ts: nextTs(ageHours), text, bot_id: botId, replies: [] };
      messages(slackChannelIds[name]).push(seeded);
      return seeded;
    },
  };
}
