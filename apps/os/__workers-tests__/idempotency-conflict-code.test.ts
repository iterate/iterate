// __workers-tests__/idempotency-conflict-code.test.ts — an append whose idempotency key already names
// a different event is refused IDEMPOTENCY_CONFLICT, with the existing event's offset, on each hop an
// appender reaches the log over: loaded code's `env.ITX` (Workers RPC, the agents' settle), a
// client's capnweb session, and the platform's own `appendPlatformFact` (the Slack webhook's
// redelivery). So a caller checks the code, never the message (packages/iterate/src/lib.ts).

import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { FacetSpec } from "iterate/api";
import { errorCode } from "iterate/lib";
import { appendPlatformFact } from "../src/integrations/connections.ts";
import { adminCredentials, openSession, stub } from "./support.ts";

/** A loaded facet that appends under one key twice, with two bodies, through its own `env.ITX`, and
 *  answers what the second append was refused with, as the facet saw it. */
const CONFLICT_PROBE: FacetSpec = {
  source: {
    "worker.js": /* js */ `
import { FacetDurableObject, withItx } from "iterate/sdk";
export class ConflictProbe extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "appendTwice"];
  async appendTwice(idempotencyKey) {
    const append = (v) =>
      withItx(this.env.ITX, (itx) => itx.append({ type: "probe", idempotencyKey, payload: { v } }));
    const [first] = await append(1);
    try {
      await append(2);
      return { firstOffset: first.offset };
    } catch (error) {
      return { firstOffset: first.offset, code: error.code, data: error.data };
    }
  }
}
`,
  },
  className: "ConflictProbe",
};

test("loaded code: its itx.append under a key that names another body is refused coded, as the loaded code sees it", async () => {
  const outcome = (await stub("prj_idem_conflict_loaded").invoke([
    "itx",
    "facets",
    ["get", "probe", CONFLICT_PROBE],
    ["appendTwice", "probe-key"],
  ])) as { firstOffset: number; code?: string; data?: unknown };
  expect(outcome).toEqual({
    firstOffset: expect.any(Number),
    code: "IDEMPOTENCY_CONFLICT",
    data: { existingOffset: outcome.firstOffset },
  });
});

test("a client's capnweb session: its itx.append under a key that names another body is refused coded", async () => {
  const itx = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.get("prj_idem_conflict_capnweb");
  const [first] = await itx.append({ type: "probe", idempotencyKey: "k", payload: { v: 1 } });
  const refusal = await refusalOf(() =>
    itx.append({ type: "probe", idempotencyKey: "k", payload: { v: 2 } }),
  );
  expect(errorCode(refusal)).toBe("IDEMPOTENCY_CONFLICT");
  expect(refusal).toMatchObject({ data: { existingOffset: first.offset } });
});

test("appendPlatformFact: a fact under a key that names another body is refused coded", async () => {
  const fact = (v: number) => ({
    type: "events.iterate.com/test/fact",
    idempotencyKey: "fact-key",
    payload: { v },
  });
  await appendPlatformFact(env, "prj_idem_conflict_platform", "/", fact(1));
  const refusal = await refusalOf(() =>
    appendPlatformFact(env, "prj_idem_conflict_platform", "/", fact(2)),
  );
  expect(errorCode(refusal)).toBe("IDEMPOTENCY_CONFLICT");
  expect(refusal).toMatchObject({ data: { existingOffset: expect.any(Number) } });
});

/** What `append` came to: its refusal, or `undefined` when it answered. */
async function refusalOf(append: () => Promise<unknown>): Promise<unknown> {
  try {
    await append();
  } catch (error) {
    return error;
  }
}
