import { expect, test } from "vitest";
import { parseVoiceMarkup } from "./voice-markup.ts";

test("spoken turns parse with their speaker, interruption marked", () => {
  expect(parseVoiceMarkup(`<voice-turn speaker="person">what's the total?</voice-turn>`)).toEqual({
    kind: "turn",
    speaker: "person",
    interrupted: false,
    text: "what's the total?",
  });
  expect(
    parseVoiceMarkup(
      '<voice-turn speaker="assistant" interrupted="true">It comes to four thou</voice-turn>',
    ),
  ).toEqual({
    kind: "turn",
    speaker: "assistant",
    interrupted: true,
    text: "It comes to four thou",
  });
});

test("a voice note parses through the platform's stamps around it", () => {
  /* The routing label lands before the tag and the reply-channel coda
   * after it; the tag is the only stable part. */
  const stamped =
    "To reply to /agents/voice/chat/mobile/1: await itx.agents.get(…).message(text)\n\n" +
    "<voice-note>\nlook up the March invoice\n</voice-note>\n\n" +
    '(Reply with await itx.chat.sendMessage("…") on this stream — …)';
  expect(parseVoiceMarkup(stamped)).toEqual({
    kind: "note",
    text: "look up the March invoice",
  });
});

test("a tagged backend reply parses; the voice's stripped copy beside it does not", () => {
  expect(
    parseVoiceMarkup("<voice-reply>\nBrooklands Museum is open 10 till 5.\n</voice-reply>"),
  ).toEqual({
    kind: "reply",
    text: "Brooklands Museum is open 10 till 5.",
  });
  /* The transform strips the tags before the voice speaks, so the spoken
   * transcript copy arrives tagless and renders as a normal turn. */
  expect(parseVoiceMarkup("Brooklands Museum is open 10 till 5.")).toBeNull();
});

test("ordinary messages parse as nothing", () => {
  expect(parseVoiceMarkup("hello there")).toBeNull();
  expect(parseVoiceMarkup("")).toBeNull();
  /* A message that merely MENTIONS the tag mid-prose is not a turn. */
  expect(parseVoiceMarkup('we should rename <voice-turn speaker="person"> someday')).toBeNull();
});
