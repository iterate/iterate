// What a script's caller learns when one of its calls was refused.
//
// This exists because of a measured, silent loss on deployed preview_3. A
// back-office agent started two overlapping `showImage` requests on a device
// that accepts one at a time and returned `Promise.allSettled`. The device
// refused the second with "an image request is already in flight". What the
// agent received was:
//
//   [{"status":"fulfilled","value":true},
//    {"status":"rejected","reason":{"remote":true,"durableObjectId":"ff5ced4c..."}}]
//
// `message` and `stack` are non-enumerable on Error, so `JSON.stringify` dropped
// the explanation and kept only the two properties workerd attaches when an
// error crosses an RPC boundary. The agent then reported, accurately and
// uselessly, that no refusal text was included.
import { describe, expect, it } from "vitest";

import { serializeScriptResult } from "./script-result-serialization.ts";

/** An error as it arrives from a Durable Object across workerd's RPC boundary. */
function remoteRpcError(message: string) {
  const error = new Error(message);
  /* Own, enumerable — which is exactly why they survived a plain stringify while
   * the message did not. */
  Object.assign(error, {
    remote: true,
    durableObjectId: "ff5ced4c30e3256e83e8bfe421bb5d238ca10ba811e5a36b29393ba602c9ea47",
  });
  return error;
}

describe("serializeScriptResult", () => {
  it("keeps the refusal text that a bare stringify dropped", () => {
    /* THE REGRESSION. The exact shape from offset 302256, and what it must be. */
    const result = [
      { status: "fulfilled", value: true },
      { status: "rejected", reason: remoteRpcError("an image request is already in flight") },
    ];

    /* First, the defect itself, so the test states what it is fixing. */
    expect(JSON.stringify(result)).toContain("durableObjectId");
    expect(JSON.stringify(result)).not.toContain("already in flight");

    expect(serializeScriptResult(result)).toEqual([
      { status: "fulfilled", value: true },
      {
        status: "rejected",
        reason: { message: "an image request is already in flight", name: "Error" },
      },
    ]);
  });

  it("does not leak the infrastructure properties workerd attached", () => {
    /* The message explains the refusal; a durable object id identifies a shard
     * and belongs in no model's context. */
    const json = JSON.stringify(serializeScriptResult(remoteRpcError("nope")));
    expect(json).toContain("nope");
    expect(json).not.toContain("durableObjectId");
    expect(json).not.toContain("remote");
  });

  it("does not include a stack", () => {
    /* Internal file names and line numbers are not an explanation. */
    const serialized = serializeScriptResult(new Error("boom")) as Record<string, unknown>;
    expect(Object.keys(serialized).sort()).toEqual(["message", "name"]);
  });

  it("converts an error that is not an instance of this realm's Error", () => {
    /*
     * An error crossing a dynamic-worker boundary need not be an instance of
     * this realm's Error — it arrives as a plain object wearing the shape. That
     * is the case that actually occurs in production, so shape is what is
     * checked, not the prototype.
     */
    const foreign = { message: "device is busy", name: "TypeError", stack: "at x (y.ts:1)" };
    expect(serializeScriptResult({ outcome: foreign })).toEqual({
      outcome: { message: "device is busy", name: "TypeError" },
    });
  });

  it("finds errors nested at any depth", () => {
    const serialized = serializeScriptResult({
      results: [{ inner: { deeper: new Error("still here") } }],
    });
    expect(JSON.stringify(serialized)).toContain("still here");
  });

  it("preserves a custom error name, which says which kind of failure it was", () => {
    const named = new Error("expected 0-100");
    named.name = "ValidationError";
    expect(serializeScriptResult(named)).toEqual({
      message: "expected 0-100",
      name: "ValidationError",
    });
  });

  it("leaves ordinary data exactly as JSON would", () => {
    /* The fix is narrow: everything that was already right stays right. */
    expect(serializeScriptResult({ a: 1, b: "two", c: [true, null] })).toEqual({
      a: 1,
      b: "two",
      c: [true, null],
    });
  });

  it("does not mistake a plain message-bearing object for an error", () => {
    /*
     * `{message: "hi"}` is data — a chat payload, a device reply — and rewriting
     * it as an error would corrupt legitimate results. A stack or a name
     * alongside the message is what marks something as thrown.
     */
    expect(serializeScriptResult({ message: "hello" })).toEqual({ message: "hello" });
  });

  it("keeps JSON's normalization of dates", () => {
    const when = new Date("2026-08-04T02:52:42.019Z");
    expect(serializeScriptResult({ when })).toEqual({ when: "2026-08-04T02:52:42.019Z" });
  });

  it("still throws on a cyclic value rather than reshaping it", () => {
    /* JSON's rejection semantics were deliberate at this boundary and stay. */
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => serializeScriptResult(cyclic)).toThrow(TypeError);
  });

  it("returns undefined for a script that returned nothing", () => {
    expect(serializeScriptResult(undefined)).toBeUndefined();
    /* And for a value JSON serializes away entirely. */
    expect(serializeScriptResult(() => 1)).toBeUndefined();
  });
});
