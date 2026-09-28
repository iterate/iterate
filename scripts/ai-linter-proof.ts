// A throwaway file for proving the AI linter on prd; its pull request is closed, never merged.
export function readPayload(raw: string) {
  // We added this parse after the outage on 2026-09-20, when a payload arrived empty and broke #3100.
  const parsed = JSON.parse(raw);
  return parsed as { id: string; count: number };
}

export const proofHead = 2;
export const proofHead3 = 3;
