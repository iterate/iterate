// The light markup voice calls leave on a chat's stream, parsed for
// presentation. The facet's transcript lane copies each spoken turn as
// `<voice-turn speaker="person|assistant" [interrupted="true"]>…</voice-turn>`
// and the frontend's notes to the backend arrive wrapped in `<voice-note>` —
// tags chosen so the MODEL reads them as the labels they are while the chat
// UI renders the sides properly (spoken turns as italic person/assistant
// bubbles, notes as collapsed rows) instead of a wall of identical rows.
// Pure string parsing; the reducer stays untouched — this is presentation.

export type VoiceMarkup =
  | {
      kind: "turn";
      speaker: "person" | "assistant";
      interrupted: boolean;
      /** What drew a spoken assistant turn, when the facet stamped it:
       * "note" = reading the backend's reply aloud, "status" = progress
       * aside, "tool" = tool follow-up. Absent = real conversation. */
      spokenKind: string | null;
      text: string;
    }
  | { kind: "note"; text: string }
  | { kind: "reply"; text: string };

const TURN_PATTERN =
  /^<voice-turn speaker="(person|assistant)"( interrupted="true")?(?: kind="([a-z]+)")?>([\s\S]*?)<\/voice-turn>\s*$/;
const NOTE_PATTERN = /<voice-note>\n?([\s\S]*?)\n?<\/voice-note>/;
/* Anchored: the backend wraps the WHOLE reply, and prose that merely
 * mentions the tag must not collapse. */
const REPLY_PATTERN = /^\s*<voice-reply>\s*([\s\S]*?)\s*<\/voice-reply>\s*$/;

export function parseVoiceMarkup(text: string): VoiceMarkup | null {
  const turn = TURN_PATTERN.exec(text);
  if (turn !== null) {
    return {
      kind: "turn",
      speaker: turn[1] as "person" | "assistant",
      interrupted: turn[2] !== undefined,
      spokenKind: turn[3] || null,
      text: turn[4]!.trim(),
    };
  }
  /* Anywhere, not anchored: the platform stamps a routing label before the
   * note and the facet appends a reply-channel coda after it — the tag is
   * the only stable part. */
  const note = NOTE_PATTERN.exec(text);
  if (note !== null) return { kind: "note", text: note[1]!.trim() };
  const reply = REPLY_PATTERN.exec(text);
  if (reply !== null) return { kind: "reply", text: reply[1]! };
  return null;
}
