import { DatabaseService } from "./db/index.ts";
import { OpencodeService } from "./opencode-service.ts";
import { DiscordService } from "./discord-service.ts";
import { DISCORD_TOKEN, TARGET_GUILD_ID } from "./config.ts";

export async function startDiscordIfDefined() {
  if (!DISCORD_TOKEN || !TARGET_GUILD_ID) {
    console.log(
      "[discord] Skipping Discord client startup, missing required environment variables",
    );
    return;
  }
  const db = new DatabaseService();
  const opencode = new OpencodeService();
  const discord = new DiscordService(db, opencode);
  return { discord, db, opencode };
}

if (import.meta.main) {
  startDiscordIfDefined().catch(console.error);
}
