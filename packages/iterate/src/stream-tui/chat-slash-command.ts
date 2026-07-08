/**
 * Slash commands typed into the chat composer: a magic message prefix the TUI
 * handles itself instead of sending it to the agent as a chat turn. (`/`, not
 * `!` — on a CLI `!` conventionally means "run a shell command".) Unknown `/…`
 * inputs are left alone so they fall through to a normal message.
 *
 * The local filesystem is shared with the agent you're chatting with by default
 * (see agent-connection.ts). `/share` widens that to the whole project — every
 * agent in the project can reach your machine while the CLI runs — and
 * `/unshare` narrows it back to this session.
 */
export type ChatSlashCommand = { kind: "share" } | { kind: "unshare" };

export function parseChatSlashCommand(input: string): ChatSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const command = trimmed.slice(1).trim().toLowerCase();
  if (command === "share") return { kind: "share" };
  if (command === "unshare") return { kind: "unshare" };
  return null;
}
