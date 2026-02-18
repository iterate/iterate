import * as Discord from "discord.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";

const DAEMON_BASE_URL = process.env.DAEMON_BASE_URL ?? "http://localhost:3001";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const PORT = process.env.PORT;

if (!PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL is not set");
if (!PORT) throw new Error("PORT is not set");

const app = new Hono();

app.get("/health", (c) => c.json({ status: "ok" }));

type CodemodeSession = {
  agentPath: string;
  agentType: string;
  id: string;
};

const client = new Discord.Client({
  intents: [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMessages,
    Discord.GatewayIntentBits.GuildMembers,
    Discord.GatewayIntentBits.GuildPresences,
    Discord.GatewayIntentBits.MessageContent,
  ],
  partials: [
    Discord.Partials.User,
    Discord.Partials.Channel,
    Discord.Partials.Message,
    Discord.Partials.Reaction,
    Discord.Partials.GuildMember,
  ],
});

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN is not set, skipping startup");
  process.exit(0);
}

const clientReady = Promise.withResolvers<void>();

client.once("clientReady", async (client) => {
  console.log(`Logged in as ${client.user.tag}`);
  clientReady.resolve();
});

await client.login(process.env.DISCORD_TOKEN);
await clientReady.promise;

if (!client.isReady())
  throw new Error("Client is not ready after ready promise resolved, unexpected state");

function toAgentPathFromThread(thread: Discord.TextBasedChannel): string | null {
  if (!thread.isThread()) return null;
  const conversationKey = `${thread.guildId}-${thread.id}`;
  return `/discord/${conversationKey}`;
}

function parseDiscordAgentPath(
  agentPath: string,
): { agentType: string; id: string; threadId: string } | null {
  if (!agentPath.startsWith("/discord/")) return null;
  const parts = agentPath.split("/");
  if (parts.length !== 3) return null;

  const agentType = parts[1];
  const id = parts[2];
  if (!agentType || !id) return null;

  const [_, threadId] = id.split("-");
  if (!threadId) return null;

  return { agentType, id, threadId };
}

async function resolveThreadFromAgentPath(
  agentPath: string,
): Promise<Discord.TextBasedChannel | null> {
  const parsed = parseDiscordAgentPath(agentPath);
  if (!parsed || parsed.agentType !== "discord") return null;
  const channel = await client.channels.fetch(parsed.threadId, { cache: true }).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

async function postDaemonJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(new URL(path, DAEMON_BASE_URL).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Daemon request failed ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function stripBotMention(text: string, botId: string): string {
  return text.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
}

function formatAttachments(message: Discord.Message): string[] {
  return [...message.attachments.values()].map((attachment) => {
    const name = attachment.name || attachment.id;
    return `- ${name}: ${attachment.url}`;
  });
}

function buildBootstrapPrompt(params: {
  message: Discord.Message;
  thread: Discord.TextBasedChannel;
  content: string;
  agentPath: string;
}): string {
  const { message, thread, content, agentPath } = params;
  const attachmentLines = formatAttachments(message);

  return [
    "You have received a message from Discord channel.",
    "",
    `Guild ID: ${message.guildId || "dm"}`,
    `Parent Channel ID: ${message.channelId}`,
    `Thread ID: ${thread.id}`,
    `Agent Path: ${agentPath}`,
    `Author: ${message.author.username} (${message.author.id})`,
    `MessageID: ${message.id}`,
    `Date: ${message.createdAt.toISOString()}`,
    `Message URL: ${message.url}`,
    "",
    "Message:",
    content || "(no text)",
    ...(attachmentLines.length > 0 ? ["", "Attachments:", ...attachmentLines] : []),
    "",
    "Use codemode to communicate via Discord.",
    `POST ${PUBLIC_BASE_URL}/codemode with JSON: {"agentPath":"${agentPath}","code":"return thread.id"}`,
    "Always pass the exact agentPath from this message.",
    "See DISCORD.md for more details.",
  ].join("\n");
}

function buildNormalPrompt(params: { message: Discord.Message; content: string }): string {
  const { message, content } = params;
  const attachmentLines = formatAttachments(message);

  return [
    `Author: ${message.author.username} (${message.author.id})`,
    `MessageID: ${message.id}`,
    `Date: ${message.createdAt.toISOString()}`,
    content || "(no text)",
    ...(attachmentLines.length > 0 ? ["", "Attachments:", ...attachmentLines] : []),
  ].join("\n");
}

async function resolveConversationThread(
  message: Discord.Message,
  mentioned: boolean,
): Promise<Discord.TextBasedChannel | null> {
  if (message.channel.isDMBased()) return null;

  if (message.channel.isThread()) {
    const botUserId = client.user?.id;
    if (!botUserId) return null;
    const isBotOwnedThread = message.channel.ownerId === botUserId;
    if (!mentioned && !isBotOwnedThread) return null;
    return message.channel;
  }

  if (!mentioned) return null;

  try {
    const thread = await message.startThread({
      name: message.cleanContent.slice(0, 50),
      autoArchiveDuration: Discord.ThreadAutoArchiveDuration.OneDay,
    });
    return thread;
  } catch (error) {
    console.error("[discord] failed to create thread from mention", error);
    return null;
  }
}

async function ensureAgentSubscription(agentPath: string): Promise<boolean> {
  const createResult = await postDaemonJson<{ result: { data: { wasNewlyCreated: boolean } } }>(
    "/api/trpc/getOrCreateAgent",
    {
      agentPath,
      createWithEvents: [],
    },
  );

  console.log("[discord] created agent", createResult);

  await postDaemonJson<unknown>("/api/trpc/subscribeToAgentChanges", {
    agentPath,
    callbackUrl: new URL("/state-changed-callback", PUBLIC_BASE_URL).toString(),
  });

  return createResult.result.data.wasNewlyCreated;
}

async function sendMessageToAgent(params: { agentPath: string; message: string }): Promise<void> {
  await postDaemonJson<{ success?: boolean }>(`/api/agents${params.agentPath}`, {
    type: "iterate:agent:prompt-added",
    message: params.message,
  });
}

app.post("/state-changed-callback", async (c) => {
  console.log("[discord] agent-change-callback", await c.req.text());
  return c.json({ success: true });
});

app.post("/codemode", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const payload = body as { agentPath?: unknown; code?: unknown };
  if (typeof payload.agentPath !== "string" || !payload.agentPath.trim()) {
    return c.json({ error: "agentPath is required" }, 400);
  }
  if (typeof payload.code !== "string" || !payload.code.trim()) {
    return c.json({ error: "code is required" }, 400);
  }

  const agentPath = payload.agentPath;
  const parsed = parseDiscordAgentPath(agentPath);
  if (!parsed) return c.json({ error: "Invalid agentPath" }, 400);

  const thread = await resolveThreadFromAgentPath(agentPath);
  if (!thread) return c.json({ error: "Unknown agentPath" }, 404);

  const session: CodemodeSession = { agentPath, agentType: parsed.agentType, id: parsed.id };

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  try {
    const execute = new AsyncFunction("{ thread, client, session, globalThis }", payload.code);
    const result = await execute({ thread, client, session, globalThis });
    return c.json({ success: true, result });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const botUserId = client.user?.id;
  if (!botUserId) return;
  const mentioned = message.mentions.users.has(botUserId);
  const conversationThread = await resolveConversationThread(message, mentioned);
  if (!conversationThread) return;

  try {
    const agentPath = toAgentPathFromThread(conversationThread);
    if (!agentPath) return;
    const shouldSendBootstrapPrompt = await ensureAgentSubscription(agentPath);

    const text = stripBotMention(message.content, botUserId);

    const prompt = shouldSendBootstrapPrompt
      ? buildBootstrapPrompt({
          message,
          thread: conversationThread,
          content: text,
          agentPath,
        })
      : buildNormalPrompt({
          message,
          content: text,
        });

    await sendMessageToAgent({ agentPath, message: prompt });
  } catch (error) {
    console.error("[discord] failed to emit message to daemon", error);
    if ("send" in conversationThread && typeof conversationThread.send === "function") {
      await conversationThread.send("Message not sent to daemon. Please retry.");
    }
  }
});

const server = serve({ fetch: app.fetch, port: Number(PORT) }, () => {
  console.log(`[discord] callback service listening on ${PUBLIC_BASE_URL}`);
});

(["SIGINT", "SIGTERM"] as const).forEach((signal) => {
  process.on(signal, () => {
    console.log(`[discord] received ${signal}, shutting down...`);
    server.close(() => process.exit(0));
  });
});
