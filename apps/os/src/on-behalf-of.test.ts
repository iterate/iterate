// on-behalf-of.test.ts — who a script runs for, as the runner signs it and an append verifies it.
import { RUN_DEADLINE_MS } from "iterate/stream/run";
import { expect, test } from "vitest";
import { signClaims } from "./caller.ts";
import { mintOnBehalfOf, verifyOnBehalfOf } from "./on-behalf-of.ts";

const SECRET = "test-secret";
const now = Date.parse("2026-09-30T10:00:00.000Z");
const onBehalfOf = {
  principal: { actor: "user_1", email: "misha@example.com" },
  grant: "grant_claude",
  run: "/@83",
};

test("a run's token proves who it runs for, in its project, until a minute past its deadline", async () => {
  const token = await mintOnBehalfOf(onBehalfOf, "prj_a", SECRET, now);
  expect(await verifyOnBehalfOf(token, "prj_a", SECRET, now)).toEqual(onBehalfOf);
  const late = now + RUN_DEADLINE_MS + 60_000 + 1;
  expect(await verifyOnBehalfOf(token, "prj_a", SECRET, late)).toBeUndefined();
});

test.for<{ name: string; token: () => Promise<string | undefined>; project?: string }>([
  { name: "no token", token: async () => undefined },
  { name: "another project's", token: () => mintOnBehalfOf(onBehalfOf, "prj_b", SECRET, now) },
  {
    name: "signed with another secret",
    token: () => mintOnBehalfOf(onBehalfOf, "prj_a", "x", now),
  },
  {
    name: "claims loaded code made up and signed itself",
    token: () =>
      signClaims(
        { purpose: "on-behalf-of", onBehalfOf, project: "prj_a", expiresAt: now + 1 },
        "made-up",
      ),
  },
  {
    name: "another token the same secret signed, with the same claims but no purpose",
    token: () => signClaims({ onBehalfOf, project: "prj_a", expiresAt: now + 1 }, SECRET),
  },
  {
    name: "a real token with its payload swapped",
    token: async () => {
      const [, signature] = (await mintOnBehalfOf(onBehalfOf, "prj_a", SECRET, now)).split(".");
      const other = await mintOnBehalfOf({ ...onBehalfOf, run: "/@1" }, "prj_a", SECRET, now);
      return `${other.split(".")[0]}.${signature}`;
    },
  },
])("names nobody: $name", async ({ token }) => {
  expect(await verifyOnBehalfOf(await token(), "prj_a", SECRET, now)).toBeUndefined();
});
