import * as Discord from "discord.js";
import { eq } from "drizzle-orm";
import * as config from "./config.ts";
import { DatabaseService } from "./db/index.ts";

export async function registerCommands(client: Discord.Client, db: DatabaseService) {
  const commands = [
    new Discord.SlashCommandBuilder()
      .setName("attach")
      .setDescription("Attach to this session")
      .addStringOption((option) =>
        option
          .setName("type")
          .setDescription("The type of client to attach to")
          .addChoices(
            { name: "OpenCode Web", value: "web" },
            { name: "OpenCode TUI", value: "tui" },
          )
          .setRequired(false),
      ),
  ];

  const rest = new Discord.REST().setToken(config.DISCORD_TOKEN);

  try {
    console.log("[discord] Registering slash commands...");
    await rest.put(
      Discord.Routes.applicationGuildCommands(client.user!.id, config.TARGET_GUILD_ID),
      {
        body: commands.map((cmd) => cmd.toJSON()),
      },
    );
    console.log("[discord] Slash commands registered");
  } catch (error) {
    console.error("[discord] Failed to register commands:", error);
  }

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "attach") return;

    await handleAttachCommand(interaction, db);
  });
}

async function handleAttachCommand(
  interaction: Discord.ChatInputCommandInteraction,
  db: DatabaseService,
) {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({
      content: "This command can only be used in an opencode thread",
      flags: Discord.MessageFlags.Ephemeral,
    });
    return;
  }

  const mapping = await db.db.query.sessionToThread.findFirst({
    where: eq(DatabaseService.SCHEMA.sessionToThread.threadID, interaction.channel.id),
  });

  if (!mapping) {
    await interaction.reply({
      content: "This thread is not attached to any opencode session",
      flags: Discord.MessageFlags.Ephemeral,
    });
    return;
  }

  const choice = interaction.options.getString("type") ?? "web";
  const { sessionID, directory } = mapping;

  if (choice === "web") {
    const encodedDir = Buffer.from(directory).toString("base64url");
    const url = `${config.OPENCODE_PUBLIC_URL}/${encodedDir}/session/${sessionID}`;
    await interaction.reply({
      content: `[Open in OpenCode Web](<${url}>)`,
    });
    return;
  }

  const command = `opencode attach '${config.OPENCODE_PUBLIC_URL}' --dir '${directory}' -s '${sessionID}'`;
  await interaction.reply({
    content: `Connect to this session from OpenCode TUI:\n${Discord.codeBlock(command)}`,
  });
}
