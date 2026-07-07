/**
 * Bang commands typed into the chat composer, in the spirit of Slack's `!debug`:
 * a magic message prefix the TUI handles itself instead of sending it to the
 * agent as a chat turn. Unknown `!…` inputs are left alone so they fall through
 * to a normal message.
 */
export type ChatBangCommand = { kind: "share" } | { kind: "unshare" };

export function parseChatBangCommand(input: string): ChatBangCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("!")) return null;
  const command = trimmed.slice(1).trim().toLowerCase();
  if (command === "share") return { kind: "share" };
  if (command === "unshare") return { kind: "unshare" };
  return null;
}
