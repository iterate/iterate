// context/caller-capability.test.ts — the rules of caller-capability.ts as table rows: where the facet
// is hosted, where the call originated, whether the facet's class lists `forCaller`, and what the
// caller's walk runs as. The same rules end to end are e2e/for-caller.e2e.test.ts.
import { expect, test } from "vitest";
import { errorCode } from "iterate/lib";
import type { ItxExpression } from "iterate/expression";
import type { ItxCaller, ItxEntrypointService } from "iterate/sdk";
import { stepsForCaller } from "./caller-capability.ts";

const CALLER_ROWS: {
  host: string;
  origin: string;
  servesCallers: boolean;
  runs: "the caller's walk" | "forCaller(<origin>), then the caller's walk" | "FORBIDDEN";
}[] = [
  // 1. At the host or above it: the walk, as for any facet.
  { host: "/", origin: "/", servesCallers: true, runs: "the caller's walk" },
  { host: "/mid", origin: "/mid", servesCallers: true, runs: "the caller's walk" },
  { host: "/mid", origin: "/", servesCallers: true, runs: "the caller's walk" },
  { host: "/mid/x", origin: "/mid", servesCallers: true, runs: "the caller's walk" },
  // 2. Strictly beneath: forCaller first, with the origin's capability.
  {
    host: "/",
    origin: "/jail",
    servesCallers: true,
    runs: "forCaller(<origin>), then the caller's walk",
  },
  {
    host: "/",
    origin: "/jail/a/sandbox",
    servesCallers: true,
    runs: "forCaller(<origin>), then the caller's walk",
  },
  {
    host: "/mid",
    origin: "/mid/x",
    servesCallers: true,
    runs: "forCaller(<origin>), then the caller's walk",
  },
  // 3. Beside: refused, a path that merely starts with the host's name included.
  { host: "/mid", origin: "/other", servesCallers: true, runs: "FORBIDDEN" },
  { host: "/mid", origin: "/middle", servesCallers: true, runs: "FORBIDDEN" },
  { host: "/mid/x", origin: "/mid/y", servesCallers: true, runs: "FORBIDDEN" },
  // A facet that lists no forCaller: called as its host from anywhere.
  { host: "/", origin: "/jail", servesCallers: false, runs: "the caller's walk" },
  { host: "/mid", origin: "/other", servesCallers: false, runs: "the caller's walk" },
];

test.each(CALLER_ROWS)(
  "a facet at $host (lists forCaller: $servesCallers), called from $origin → $runs",
  ({ host, origin, servesCallers, runs }) => {
    const itx = {} as ItxEntrypointService; // opaque to the rule: only the platform mints one
    const steps: ItxExpression = [["hello", 1]];
    let outcome: unknown;
    try {
      outcome = stepsForCaller({
        facet: "f",
        host,
        origin,
        servesCallers,
        steps,
        callerAt: (path): ItxCaller => ({ path, itx }),
      });
    } catch (error) {
      outcome = errorCode(error);
    }
    expect(outcome).toEqual(
      {
        "the caller's walk": steps,
        "forCaller(<origin>), then the caller's walk": [
          ["forCaller", { path: origin, itx }],
          ...steps,
        ],
        FORBIDDEN: "FORBIDDEN",
      }[runs],
    );
  },
);

test("the refusal names the facet, its host and the caller beside it", () => {
  expect(() =>
    stepsForCaller({
      facet: "ledger",
      host: "/mid",
      origin: "/other",
      servesCallers: true,
      steps: [["balance"]],
      callerAt: () => {
        throw new Error("never minted");
      },
    }),
  ).toThrow(
    `facet "ledger" at "/mid" serves its context, the contexts above it and the contexts beneath it — "/other" is beside it`,
  );
});
