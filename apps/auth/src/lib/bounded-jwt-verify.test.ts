import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JwtVerificationDeadlineError, verifyJwtWithBoundedHedges } from "./bounded-jwt-verify.ts";

describe("bounded JWT verification", () => {
  it("returns an ordinary verification without a hedge", async (t) => {
    const warning = t.mock.method(console, "warn", () => {});
    let calls = 0;

    const result = await verifyJwtWithBoundedHedges({
      attemptTimeoutsMs: [20],
      tokenKind: "access",
      verify: async () => {
        calls += 1;
        return "verified";
      },
    });

    assert.equal(result, "verified");
    assert.equal(calls, 1);
    assert.equal(warning.mock.callCount(), 0);
  });

  it("rescues a stranded native verification with a fresh pure attempt", async (t) => {
    const warning = t.mock.method(console, "warn", () => {});
    let calls = 0;

    const result = await verifyJwtWithBoundedHedges({
      attemptTimeoutsMs: [1, 20],
      tokenKind: "id",
      verify: async () => {
        calls += 1;
        if (calls === 1) return await new Promise<string>(() => {});
        return "verified";
      },
    });

    assert.equal(result, "verified");
    assert.equal(calls, 2);
    assert.equal(warning.mock.callCount(), 2);
  });

  it("does not retry an explicit verification rejection", async () => {
    const rejection = new Error("invalid signature");
    let calls = 0;

    await assert.rejects(
      verifyJwtWithBoundedHedges({
        attemptTimeoutsMs: [20, 20],
        tokenKind: "access",
        verify: async () => {
          calls += 1;
          throw rejection;
        },
      }),
      (error: unknown) => error === rejection,
    );
    assert.equal(calls, 1);
  });

  it("fails explicitly after the bounded deadline", async (t) => {
    t.mock.method(console, "warn", () => {});
    const errorLog = t.mock.method(console, "error", () => {});
    let calls = 0;

    await assert.rejects(
      verifyJwtWithBoundedHedges({
        attemptTimeoutsMs: [1, 1],
        tokenKind: "bearer",
        verify: async () => {
          calls += 1;
          return await new Promise<string>(() => {});
        },
      }),
      JwtVerificationDeadlineError,
    );
    assert.equal(calls, 2);
    assert.equal(errorLog.mock.callCount(), 1);
  });
});
