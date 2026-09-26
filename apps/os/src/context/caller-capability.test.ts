// context/caller-capability.test.ts — the rules of caller-capability.ts as table rows: where the
// service is hosted, where the call originated, whether it serves callers, and what the caller's walk
// runs as. The same rules end to end are e2e/for-caller.e2e.test.ts.
import { expect, test } from "vitest";
import type { ItxExpression } from "iterate/expression";
import type { ItxCaller, ItxEntrypointService } from "iterate/sdk";
import { stepsForCaller } from "./caller-capability.ts";

const CALLER_ROWS: {
  host: string;
  origin: string;
  servesCallers: boolean;
  runs: "the caller's walk" | "forCaller(<origin>), then the caller's walk";
}[] = [
  // 1. At the host or above it: the walk, as for any service.
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
  // 3. Beside: served as the host — no refusal, and no handle handed over, a path that merely
  //    starts with the host's name included.
  { host: "/mid", origin: "/other", servesCallers: true, runs: "the caller's walk" },
  { host: "/mid", origin: "/middle", servesCallers: true, runs: "the caller's walk" },
  { host: "/mid/x", origin: "/mid/y", servesCallers: true, runs: "the caller's walk" },
  // A service that serves no callers: called as its host from anywhere.
  { host: "/", origin: "/jail", servesCallers: false, runs: "the caller's walk" },
  { host: "/mid", origin: "/other", servesCallers: false, runs: "the caller's walk" },
];

test.for(CALLER_ROWS)(
  "a service at $host (serves callers: $servesCallers), called from $origin → $runs",
  ({ host, origin, servesCallers, runs }) => {
    const itx = {} as ItxEntrypointService; // opaque to the rule: only the platform mints one
    const steps: ItxExpression = [["hello", 1]];
    expect(
      stepsForCaller({
        host,
        origin,
        servesCallers,
        steps,
        callerAt: (path): ItxCaller => ({ path, itx }),
      }),
    ).toEqual(
      {
        "the caller's walk": steps,
        "forCaller(<origin>), then the caller's walk": [
          ["forCaller", { path: origin, itx }],
          ...steps,
        ],
      }[runs],
    );
  },
);
