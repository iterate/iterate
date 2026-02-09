import { stripVTControlCharacters } from "node:util";
import { format, inspect } from "node:util";
import * as OpenCode from "@opencode-ai/sdk/v2";
import * as Discord from "discord.js";
import { eq } from "drizzle-orm";
import { chunkMarkdown } from "./markdown.ts";
import { OpencodeService } from "./opencode-service.ts";
import { DatabaseService } from "./db/index.ts";
import { formatToolCallSummary } from "./tools.ts";
import { registerCommands } from "./commands.ts";
import * as config from "./config.ts";

type InputPart =
  | OpenCode.TextPartInput
  | OpenCode.FilePartInput
  | OpenCode.AgentPartInput
  | OpenCode.SubtaskPartInput;

type BufferedTextPart = {
  part: OpenCode.TextPart;
};

export class DiscordService {
  public readonly client: Discord.Client;
  private bufferedTextParts = new Map<string, Map<string, BufferedTextPart>>();
  private sentPartIds = new Set<string>();

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly opencodeService: OpencodeService,
  ) {
    this.client = new Discord.Client({
      intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.MessageContent,
        Discord.GatewayIntentBits.GuildMembers,
        Discord.GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Discord.Partials.Message, Discord.Partials.Channel, Discord.Partials.Reaction],
    });

    this.setupDiscordHandlers();
    void this.client.login(config.DISCORD_TOKEN);
  }

  private setupDiscordHandlers() {
    const db = this.databaseService.db;
    const schema = DatabaseService.SCHEMA;
    const discordClient = this.client;
    const opencodeClient = this.opencodeService.client;

    discordClient.once("clientReady", async () => {
      console.log(`[discord] Logged in as ${discordClient.user?.tag}`);
      await registerCommands(this.client, this.databaseService);
    });

    discordClient.on("error", (error) => {
      console.error("[discord] Client error:", error);
    });

    // Abort session on stop emoji
    discordClient.on("messageReactionAdd", async (reaction, user) => {
      if (reaction.emoji.name === "🛑") {
        await this.handleAbortSessionOnReaction(reaction, user);
      }
    });

    // Handle messages
    discordClient.on("messageCreate", async (message) => {
      if (!this.isAllowedMessage(message)) return;

      // Thread message - find existing session
      if (message.channel.isThread()) {
        const mapping = await this.sessionFromThreadID(message.channel.id);
        if (!mapping) {
          await message.reply({
            content: "No stored session found for this thread.",
          });
          return;
        }
        return this.sendDiscordThreadMessageToOpencodeSession(message, mapping.session);
      }

      // New message in main channel - create session and thread
      const directory = config.INITIAL_CWD;
      const session = await opencodeClient.session.create({ directory });

      if (session.error) {
        const errorDetails =
          typeof session.error.data === "object" && session.error.data !== null
            ? inspect(session.error.data, { depth: 1, colors: false })
            : format("%s", session.error.data ?? "Unknown error");
        await message.reply({
          content: `Error creating session:\n${Discord.codeBlock(errorDetails)}`,
        });
        return;
      }

      const thread = await message.startThread({ name: session.data.title });

      await db.insert(schema.sessionToThread).values({
        sessionID: session.data.id,
        threadID: thread.id,
        directory,
      });

      return this.sendDiscordThreadMessageToOpencodeSession(message, session.data);
    });

    // OpenCode events
    this.opencodeService.events
      .on("message.updated", async (event) => {
        const { sessionID, role, id: messageID } = event.payload.properties.info;
        if (role !== "assistant" || !("completed" in event.payload.properties.info.time)) return;

        const thread = await this.threadFromSessionID(sessionID);
        if (!thread) return;

        // Flush remaining buffered text parts on message completion
        await this.flushBufferedTextParts(messageID, thread.thread);

        // Clean up buffers
        const messageBuffer = this.bufferedTextParts.get(messageID);
        if (messageBuffer) {
          for (const partId of messageBuffer.keys()) {
            this.sentPartIds.delete(partId);
          }
          this.bufferedTextParts.delete(messageID);
        }
      })
      .on("message.part.updated", async (event) => {
        const part = event.payload.properties.part;

        if (part.type === "text") {
          await this.handleTextPart(part);
          return;
        }

        if (part.type === "tool") {
          await this.handleToolCallPart(part);
        }
      })
      .on("session.updated", async (event) => {
        const newTitle = event.payload.properties.info.title;
        const thread = await this.threadFromSessionID(event.payload.properties.info.id);
        if (!thread) return;
        if (thread.thread.name !== newTitle) {
          await thread.thread.setName(newTitle);
        }
      })
      .on("session.status", async (event) => {
        const { sessionID, status } = event.payload.properties;
        if (status.type !== "retry") return;

        const thread = await this.threadFromSessionID(sessionID);
        if (!thread) return;

        const retryIn = Math.max(0, Math.ceil((status.next - Date.now()) / 1000));
        await thread.thread.send({
          content: `⏳ ${status.message} — retrying in ${retryIn}s (attempt #${status.attempt})`,
        });
      })
      .on("session.error", async (event) => {
        const { sessionID, error } = event.payload.properties;
        if (!error || !sessionID) return;
        if (error.name === "MessageAbortedError") return;

        const thread = await this.threadFromSessionID(sessionID);
        if (!thread) return;

        const errorMessage = this.formatProviderError(error);
        await thread.thread.send({
          content: `❌ **Error:** ${errorMessage}`,
        });
      });
  }

  private formatProviderError(
    error:
      | OpenCode.ProviderAuthError
      | OpenCode.UnknownError
      | OpenCode.MessageOutputLengthError
      | OpenCode.ApiError,
  ): string {
    switch (error.name) {
      case "APIError":
        return `${error.data.message}${error.data.statusCode ? ` (${error.data.statusCode})` : ""}`;
      case "ProviderAuthError":
        return `Auth error for ${error.data.providerID}: ${error.data.message}`;
      case "MessageOutputLengthError":
        return "Output length exceeded";
      case "UnknownError":
        return error.data.message;
      default:
        return "Unknown error occurred";
    }
  }

  private isAllowedMessage(message: Discord.Message) {
    return (
      !message.author.bot &&
      message.guildId === config.TARGET_GUILD_ID &&
      (message.channel.isThread()
        ? message.channel.parentId === config.TARGET_CHANNEL_ID
        : message.channel.id === config.TARGET_CHANNEL_ID)
    );
  }

  private async sendDiscordThreadMessageToOpencodeSession(
    message: Discord.Message,
    session: OpenCode.Session,
  ) {
    const content = message.content;

    // Shell mode: if message starts with !, execute as shell command
    if (content.startsWith("!")) {
      const command = content.slice(1).trim();
      if (command) {
        return this.executeShellCommand(message, session, command);
      }
    }

    // Handle embeds with images
    const embedImageUrls = message.embeds
      .map((embed) => embed.image?.url ?? embed.thumbnail?.url)
      .filter((url): url is string => Boolean(url));

    const seenUrls = new Set<string>();
    const parts: InputPart[] = [];

    // Handle attachments
    if (message.attachments.size > 0) {
      for (const attachment of message.attachments.values()) {
        if (seenUrls.has(attachment.url)) continue;
        seenUrls.add(attachment.url);

        const filename = attachment.name ?? "file";
        const contentType = attachment.contentType ?? "application/octet-stream";

        if (contentType.startsWith("image/")) {
          parts.push({
            type: "file",
            filename,
            mime: contentType,
            url: attachment.url,
          });
        }
      }
    }

    // Handle embed images
    for (const imageUrl of embedImageUrls) {
      if (seenUrls.has(imageUrl)) continue;
      seenUrls.add(imageUrl);
      parts.push({
        type: "file",
        mime: "image/png",
        url: imageUrl,
        filename: "image.png",
      });
    }

    parts.unshift({
      type: "text",
      text: content,
    });

    await message.react("⏳");
    await this.sendMessageToSession(session.id, parts)
      .then(async (res) => {
        if (!res.data?.parts && !res.data?.info) {
          console.log(
            "[discord] Unexpected response:",
            inspect(res, { depth: null, colors: true }),
          );
          await message.react("❓");
        }
      })
      .catch(async (error) => {
        console.error("[discord] Error sending message:", error);
        await message.react("❌");
        await message.reply({
          content: `Error sending message: ${error.message}`,
        });
      })
      .finally(async () => {
        await message.reactions.cache
          .get("⏳")
          ?.users.remove(this.client.user!.id)
          .catch(() => null);
      });
  }

  private async executeShellCommand(
    message: Discord.Message,
    session: OpenCode.Session,
    command: string,
  ) {
    const thread = await this.threadFromSessionID(session.id);
    if (!thread) {
      await message.reply({ content: "No thread found for this session." });
      return;
    }

    await message.react("⏳");

    try {
      const result = await this.opencodeService.client.session.shell({
        sessionID: session.id,
        directory: thread.directory,
        command,
      });

      if (result.error) {
        await message.react("❌");
        await message.reply({
          content: `Error executing command:\n${Discord.codeBlock(inspect(result.error, { depth: 2 }))}`,
        });
        return;
      }

      const response = result.data as unknown as {
        info: OpenCode.AssistantMessage;
        parts: OpenCode.Part[];
      };

      const toolPart = response?.parts?.find(
        (p): p is OpenCode.ToolPart => p.type === "tool" && p.tool === "bash",
      );

      if (toolPart && toolPart.state.status === "completed") {
        const rawOutput = String(toolPart.state.metadata?.output ?? toolPart.state.output ?? "");
        const output = stripVTControlCharacters(rawOutput);
        const truncatedOutput = output.length > 1900 ? output.slice(0, 1900) + "\n..." : output;
        const formatted = `\`$ ${command}\`\n${Discord.codeBlock(truncatedOutput || "(no output)")}`;

        for (const chunk of chunkMarkdown(formatted)) {
          await thread.thread.send({ content: chunk });
        }
      } else {
        await thread.thread.send({
          content: `\`$ ${command}\`\n${Discord.codeBlock("(command executed, no output captured)")}`,
        });
      }

      await message.react("✅");
    } catch (error) {
      console.error("[discord] Shell command error:", error);
      await message.react("❌");
      await message.reply({
        content: `Error executing command: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      await message.reactions.cache.get("⏳")?.remove();
    }
  }

  private async handleAbortSessionOnReaction(
    reaction: Discord.MessageReaction | Discord.PartialMessageReaction,
    user?: Discord.User | Discord.PartialUser,
  ) {
    if (user?.bot) return;
    const fullMessage = await reaction.message.fetch();
    if (!fullMessage.channel.isThread()) return;
    if (fullMessage.guildId !== config.TARGET_GUILD_ID) return;
    if (fullMessage.channel.parentId !== config.TARGET_CHANNEL_ID) return;

    const mapping = await this.sessionFromThreadID(fullMessage.channel.id);
    if (!mapping) return;

    const result = await this.opencodeService.client.session.abort({
      sessionID: mapping.session.id,
      directory: mapping.directory,
    });
    if (result.error) {
      console.error("[discord] Failed to abort session:", result.error);
    }
  }

  private async handleToolCallPart(part: OpenCode.ToolPart) {
    const status = part.state.status;
    const thread = await this.threadFromSessionID(part.sessionID);
    if (!thread) return;

    // When a tool starts running, flush any buffered text parts first
    if (status === "running") {
      await this.flushBufferedTextParts(part.messageID, thread.thread);
      return;
    }

    if (status !== "completed" && status !== "error") return;

    // Skip compacted parts
    const compactedAt =
      part.state.time && "compacted" in part.state.time ? part.state.time.compacted : undefined;
    if (typeof compactedAt === "number") {
      return;
    }

    // Show tool call summary
    const message = formatToolCallSummary(part);
    for (const chunk of chunkMarkdown(message)) {
      await thread.thread.send({ content: chunk });
    }
  }

  private async handleTextPart(part: OpenCode.TextPart) {
    // Skip thinking blocks
    if (part.text.trim().endsWith("</think>")) return;

    // Skip if already sent
    if (this.sentPartIds.has(part.id)) return;

    const { messageID, sessionID } = part;

    // Get or create buffer for this message
    let messageBuffer = this.bufferedTextParts.get(messageID);
    if (!messageBuffer) {
      messageBuffer = new Map();
      this.bufferedTextParts.set(messageID, messageBuffer);
    }

    // Update the buffered part
    messageBuffer.set(part.id, { part });

    // If text part is complete (time.end is set), send it now
    if (part.time?.end) {
      if (this.sentPartIds.has(part.id)) return;

      this.sentPartIds.add(part.id);

      const thread = await this.threadFromSessionID(sessionID);
      if (thread) {
        const text = part.text.trim();
        if (text) {
          for (const chunk of chunkMarkdown(text)) {
            await thread.thread.send({ content: chunk });
          }
        }
      }
    }
  }

  private async flushBufferedTextParts(messageID: string, thread: Discord.ThreadChannel) {
    const messageBuffer = this.bufferedTextParts.get(messageID);
    if (!messageBuffer) return;

    for (const [partId, buffered] of messageBuffer) {
      if (this.sentPartIds.has(partId)) continue;
      if (buffered.part.text.trim().endsWith("</think>")) continue;

      this.sentPartIds.add(partId);

      const text = buffered.part.text.trim();
      if (text) {
        for (const chunk of chunkMarkdown(text)) {
          await thread.send({ content: chunk });
        }
      }
    }
  }

  private async threadFromSessionID(sessionID: string) {
    const record = await this.databaseService.db.query.sessionToThread.findFirst({
      where: eq(DatabaseService.SCHEMA.sessionToThread.sessionID, sessionID),
    });
    if (!record) return null;

    const thread = await this.client.channels.fetch(record.threadID, { cache: true });
    if (!thread || !thread.isThread()) return null;

    return { thread, directory: record.directory };
  }

  private async sessionFromThreadID(threadID: string) {
    const record = await this.databaseService.db.query.sessionToThread.findFirst({
      where: eq(DatabaseService.SCHEMA.sessionToThread.threadID, threadID),
    });
    if (!record) return null;

    const session = await this.opencodeService.client.session.get({
      sessionID: record.sessionID,
      directory: record.directory,
    });
    if (session.error) return null;

    return { session: session.data, directory: record.directory };
  }

  private async sendMessageToSession(sessionID: string, parts: InputPart[]) {
    const thread = await this.threadFromSessionID(sessionID);
    if (!thread) {
      throw new Error(`No thread found for session ${sessionID}`);
    }

    return this.opencodeService.client.session.prompt({
      sessionID,
      directory: thread.directory,
      agent: "discord",
      parts,
    });
  }
}
