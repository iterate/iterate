import { describe, expect, test } from "vitest";
import { newCommentId, newThreadId, ulid } from "./ulid.ts";

const zeros = (n: number) => new Uint8Array(n);

describe("ulid", () => {
  test("is 26 chars of crockford base32", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test.for([
    {
      name: "epoch zero, zero randomness",
      timestamp: 0,
      random: zeros,
      expected: "00000000000000000000000000",
    },
    {
      name: "all-ones randomness",
      timestamp: 0,
      random: (n: number) => new Uint8Array(n).fill(0xff),
      expected: "0000000000ZZZZZZZZZZZZZZZZ",
    },
    {
      name: "known timestamp",
      timestamp: 1469918176385,
      random: zeros,
      expected: "01ARYZ6S410000000000000000",
    },
  ])("$name", ({ timestamp, random, expected }) => {
    expect(ulid(timestamp, random)).toBe(expected);
  });

  test("sorts lexically by timestamp", () => {
    const early = ulid(1000, zeros);
    const late = ulid(2000, zeros);
    expect(early < late).toBe(true);
  });

  test.for([
    { name: "negative", timestamp: -1 },
    { name: "too large", timestamp: 2 ** 48 },
    { name: "fractional", timestamp: 1.5 },
  ])("rejects $name timestamps", ({ timestamp }) => {
    expect(() => ulid(timestamp)).toThrow(/out of range/);
  });

  test("rejects a short random source", () => {
    expect(() => ulid(0, () => new Uint8Array(4))).toThrow(/expected 10/);
  });

  test("prefixed id helpers", () => {
    expect(newThreadId()).toMatch(/^th_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newCommentId()).toMatch(/^cm_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
