/**
 * The first proof turn exercises the optional device-tool path; later turns
 * exercise ordinary conversation on the same provider and PCM generation.
 * Requiring a sprite mutation on every utterance made provider discretion a
 * false audio failure and did not resemble how a person will use the Stick.
 * One successful raw-event-backed tool call proves `env.ITX`; keeping later
 * turns tool-free is the stronger test for persistent conversational audio.
 */
export const PRODUCTION_GROK_DEVICE_TOOL_SPRITE_SET = "karakuri-brass";

/**
 * Produces the physical spoken stimulus for the one device-tool proof turn.
 *
 * This deliberately uses the face's natural spoken name, not its compact API
 * slug. macOS pronounced `starbyte` ambiguously and xAI transcribed it as an
 * unsupported name; asking Grok to guess the enum would weaken the authority
 * boundary. The provider's closed tool schema remains responsible for mapping
 * “Karakuri Brass” to `karakuri-brass`.
 *
 * Tool-first is a transport requirement, not prompt polish. Grok can combine a
 * spoken preamble and a function call in one response. The proxy deliberately
 * does not create another response after such a mixed response because that
 * previously duplicated complete spoken answers. Asking for no preamble makes
 * the first response tool-only, so its function output has one unambiguous
 * continuation edge and the post-tool sentence is physically observable.
 */
export function productionGrokDeviceToolPrompt(releaseButtonAfterPrompt = false): string {
  return (
    "Change the face to Karakuri Brass. Call the change sprite set tool before speaking. " +
    "Do not say a preamble. " +
    "After the tool succeeds, say exactly: The brass face is active and the zebra is awake." +
    (releaseButtonAfterPrompt ? " Release Button A now." : "")
  );
}

export function productionGrokTurnRequiresDeviceTool(
  turn: number,
  explicitVoicePhrase?: string,
): boolean {
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new Error("Production Grok turn must be a positive integer.");
  }
  /*
   * An explicit phrase selects an audio scenario, such as a one-minute story.
   * It must remain independent from the default first-turn device-tool proof:
   * requiring both asks Grok to infer an unrelated sprite mutation and turns
   * a completed long playout into a false 90-second harness timeout.
   */
  return turn === 1 && !explicitVoicePhrase?.trim();
}

export function requiredDeviceToolCallsForVoiceProof(
  turns: number,
  explicitVoicePhrase?: string,
): number {
  if (!Number.isSafeInteger(turns) || turns < 1) {
    throw new Error("Production Grok proof must contain at least one turn.");
  }
  return explicitVoicePhrase?.trim() ? 0 : 1;
}
