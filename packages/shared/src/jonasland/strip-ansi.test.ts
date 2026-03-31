import { describe, expect, test } from "vitest";
import { stripAnsi } from "./strip-ansi.ts";

describe("stripAnsi", () => {
  test("removes ANSI color sequences", () => {
    expect(stripAnsi("\u001B[32mgreen\u001B[39m plain")).toBe("green plain");
  });

  test("leaves plain text unchanged", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});
