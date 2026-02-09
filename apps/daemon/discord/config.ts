export const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
export const TARGET_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID!;
export const TARGET_GUILD_ID = process.env.DISCORD_GUILD_ID!;
export const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096";
export const OPENCODE_PUBLIC_URL = process.env.OPENCODE_PUBLIC_URL ?? OPENCODE_BASE_URL;
export const INITIAL_CWD = process.env.DISCORD_WORKING_DIR ?? process.cwd();
