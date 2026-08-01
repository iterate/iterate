/**
 * The first proof turn exercises the optional device-tool path; later turns
 * exercise ordinary conversation on the same provider and PCM generation.
 * Requiring a colour mutation on every utterance made provider discretion a
 * false audio failure and did not resemble how a person will use the Stick.
 * One successful raw-event-backed tool call proves `env.ITX`; keeping later
 * turns tool-free is the stronger test for persistent conversational audio.
 */
export function productionGrokTurnRequiresDeviceTool(turn: number): boolean {
  if (!Number.isSafeInteger(turn) || turn < 1) {
    throw new Error("Production Grok turn must be a positive integer.");
  }
  return turn === 1;
}

export function requiredDeviceToolCallsForVoiceProof(turns: number): number {
  if (!Number.isSafeInteger(turns) || turns < 1) {
    throw new Error("Production Grok proof must contain at least one turn.");
  }
  return 1;
}
