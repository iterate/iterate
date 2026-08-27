# Script reuse: the second factorization should not re-derive the algorithm

Branch feature: `codemode-script-reuse` (not in production). Helpers:
`run-turn.ts` drives one chat turn to full settlement; `report.ts` dumps
every agent stream's messages, scripts, settlements, and token usage.

In a fresh project's chat:

> prime factorize 52479543428582704627

then, after the reply:

> now do 66778601389380731119

(= 6203868971 × 8459163737 and 7316102869 × 9127619251 respectively; verify
with your own arithmetic, not the agent's prose.)

Success criteria — the mechanism matters as much as the answers:

- Every chat message states correct facts. A reply pairing the new factors
  with the old number is a failure, not a correctable slip — the reuse API's
  `edits` exists precisely to rewrite stale prose.
- Turn 2 reuses turn 1's journaled script via
  `itx.capabilityHost.previousScriptHelper` (a results row spread with
  `parameterize` and, where prose needs it, `edits`), and no turn-2
  agent-authored script re-derives the factorization algorithm. The
  platform-synthesized child run (UUID executionId) carries the original
  algorithm; that is expected.
