/**
 * The first proof turn exercises the optional device-tool path; later turns
 * exercise ordinary conversation on the same provider and PCM generation.
 * Requiring a colour mutation on every utterance made provider discretion a
 * false audio failure and did not resemble how a person will use the Stick.
 * One successful raw-event-backed tool call proves `env.ITX`; keeping later
 * turns tool-free is the stronger test for persistent conversational audio.
 */
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
   * requiring both asks Grok to infer an unrelated colour mutation and turns
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
