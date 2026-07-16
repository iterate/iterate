import { describe, expect, it } from "vitest";
import { oversizedScriptResultPreview } from "./script-result-preview.ts";

describe("oversizedScriptResultPreview", () => {
  it("keeps ordinary results on the rich structured renderer", () => {
    expect(oversizedScriptResultPreview({ ok: true }, 100)).toBeNull();
  });

  it("bounds a large result before it reaches the rich renderer", () => {
    const result = oversizedScriptResultPreview({ output: "x".repeat(100) }, 32);
    expect(result).toEqual({
      preview: expect.any(String),
      totalCharacters: 118,
    });
    expect(result?.preview).toHaveLength(32);
  });
});
