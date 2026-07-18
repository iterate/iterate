import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSingleFlight } from "./single-flight.ts";

// OAuth refresh tokens rotate on use. These tests pin the per-token
// single-flight that prevents concurrent requests from reusing a spent token
// and revoking the whole session family.
describe("createSingleFlight", () => {
  it("collapses concurrent calls for the same key into one invocation", async () => {
    const singleFlight = createSingleFlight<string>();
    let calls = 0;
    let resolve!: (value: string) => void;
    const operation = () => {
      calls += 1;
      return new Promise<string>((done) => {
        resolve = done;
      });
    };

    const first = singleFlight("token-1", operation);
    const second = singleFlight("token-1", operation);
    const third = singleFlight("token-1", operation);

    assert.equal(calls, 1);
    resolve("rotated");
    assert.deepEqual(await Promise.all([first, second, third]), ["rotated", "rotated", "rotated"]);
  });

  it("runs independent keys independently", async () => {
    const singleFlight = createSingleFlight<string>();
    let calls = 0;
    const operation = async (value: string) => {
      calls += 1;
      return value;
    };

    const values = await Promise.all([
      singleFlight("token-1", () => operation("one")),
      singleFlight("token-2", () => operation("two")),
    ]);

    assert.equal(calls, 2);
    assert.deepEqual(values, ["one", "two"]);
  });

  it("clears a settled entry so a later refresh runs", async () => {
    const singleFlight = createSingleFlight<number>();
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return calls;
    };

    assert.equal(await singleFlight("token-1", operation), 1);
    assert.equal(await singleFlight("token-1", operation), 2);
  });

  it("shares a rejection and lets the next call retry", async () => {
    const singleFlight = createSingleFlight<string>();
    let failures = 0;
    const failing = async () => {
      failures += 1;
      throw new Error("refresh failed");
    };

    const first = singleFlight("token-1", failing);
    const second = singleFlight("token-1", failing);
    await assert.rejects(first, /refresh failed/);
    await assert.rejects(second, /refresh failed/);
    assert.equal(failures, 1);

    let retries = 0;
    assert.equal(
      await singleFlight("token-1", async () => {
        retries += 1;
        return "ok";
      }),
      "ok",
    );
    assert.equal(retries, 1);
  });
});
