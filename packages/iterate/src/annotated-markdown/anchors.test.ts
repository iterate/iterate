import { describe, expect, test } from "vitest";
import { createAnchorSelector, findInlineMarker, resolveThreadAnchor } from "./anchors.ts";

describe("createAnchorSelector", () => {
  test("captures quote, context, and position", () => {
    const body = "The retry loop masks the real failure entirely.";
    const start = body.indexOf("masks");
    const selector = createAnchorSelector(body, start, start + "masks".length, 8);
    expect(selector).toEqual({
      quote: { exact: "masks", prefix: "ry loop ", suffix: " the rea" },
      position: { start: 15, end: 20 },
    });
  });

  test("clamps context at document edges", () => {
    const selector = createAnchorSelector("abc", 0, 3);
    expect(selector).toEqual({
      quote: { exact: "abc", prefix: "", suffix: "" },
      position: { start: 0, end: 3 },
    });
  });

  test("rejects empty or out-of-range selections", () => {
    expect(() => createAnchorSelector("abc", 1, 1)).toThrow(/invalid anchor selection/);
    expect(() => createAnchorSelector("abc", 2, 9)).toThrow(/invalid anchor selection/);
  });
});

describe("resolveThreadAnchor", () => {
  const selector = (body: string, exact: string) => {
    const start = body.indexOf(exact);
    return createAnchorSelector(body, start, start + exact.length);
  };

  test("an inline marker wins and recovers the quoted range before it", () => {
    const original = "Alpha beta gamma.";
    const sel = selector(original, "beta");
    const withMarker = "Alpha beta [T1](#thread-th_1) gamma.";
    const resolved = resolveThreadAnchor(withMarker, "th_1", sel);
    expect(resolved).toEqual({
      state: "attached",
      method: "marker",
      range: { start: 6, end: 10 },
      confidence: 1,
    });
    expect(withMarker.slice(6, 10)).toBe("beta");
  });

  test("a marker with no surviving quote anchors at the marker itself", () => {
    const body = "Rewritten completely [T1](#thread-th_1) elsewhere.";
    const resolved = resolveThreadAnchor(body, "th_1", selector("Alpha beta gamma.", "beta"));
    expect(resolved.state).toBe("attached");
    expect(resolved.method).toBe("marker");
    expect(body.slice(resolved.range?.start, resolved.range?.end)).toBe("[T1](#thread-th_1)");
  });

  test("no selector and no marker is orphaned", () => {
    expect(resolveThreadAnchor("Some text.", "th_1", null)).toEqual({
      state: "orphaned",
      method: null,
      range: null,
      confidence: 0,
    });
  });

  test("stored position is used while the text at it still matches", () => {
    const body = "Alpha beta gamma.";
    const resolved = resolveThreadAnchor(body, "th_1", selector(body, "beta"));
    expect(resolved).toEqual({
      state: "attached",
      method: "position",
      range: { start: 6, end: 10 },
      confidence: 1,
    });
  });

  test("a moved unique quote re-anchors by search", () => {
    const original = "Alpha beta gamma.";
    const sel = selector(original, "beta");
    const moved = `A new opening paragraph.\n\n${original}`;
    const resolved = resolveThreadAnchor(moved, "th_1", sel);
    expect(resolved.state).toBe("attached");
    expect(resolved.method).toBe("quote");
    expect(moved.slice(resolved.range?.start, resolved.range?.end)).toBe("beta");
  });

  test("duplicated quotes disambiguate by prefix and suffix", () => {
    const original = "First stanza uses beta here. Second stanza uses beta there.";
    const start = original.indexOf("beta there");
    const sel = createAnchorSelector(original, start, start + 4);
    const moved = `Preamble.\n${original}`;
    const resolved = resolveThreadAnchor(moved, "th_1", sel);
    expect(resolved.state).toBe("attached");
    expect(resolved.method).toBe("quote");
    expect(moved.slice(resolved.range?.start ?? 0 - 10, resolved.range?.end)).toContain("beta");
    expect(moved.slice(resolved.range?.end ?? 0, (resolved.range?.end ?? 0) + 6)).toBe(" there");
  });

  test("duplicated quotes with identical context need review", () => {
    const body = "same context beta same context. same context beta same context.";
    const sel = { quote: { exact: "beta", prefix: "xt ", suffix: " sa" } };
    const resolved = resolveThreadAnchor(body, "th_1", sel);
    expect(resolved.state).toBe("needs_review");
  });

  test("whitespace reflow attaches via normalized matching", () => {
    const original = "The quick brown fox jumps over the lazy dog near the river bank.";
    const sel = selector(original, "jumps over the lazy dog");
    const reflowed = "The quick brown fox jumps\nover the   lazy dog near the river bank.";
    const resolved = resolveThreadAnchor(reflowed, "th_1", sel);
    expect(resolved.state).toBe("attached");
    expect(resolved.method).toBe("fuzzy");
    expect(resolved.confidence).toBe(0.95);
    expect(reflowed.slice(resolved.range?.start, resolved.range?.end)).toBe(
      "jumps\nover the   lazy dog",
    );
  });

  test("a small edit inside the quote attaches fuzzily", () => {
    const original =
      "Publishing must durably enqueue the invalidation event before returning to the caller.";
    const sel = selector(original, "durably enqueue the invalidation event");
    const edited =
      "Publishing must durably enqueue the invalidation record before returning to the caller.";
    const resolved = resolveThreadAnchor(edited, "th_1", sel);
    expect(resolved.state).toBe("attached");
    expect(resolved.method).toBe("fuzzy");
    expect(resolved.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("a vanished quote is orphaned", () => {
    const sel = selector("Alpha beta gamma delta.", "beta gamma");
    const resolved = resolveThreadAnchor("Completely different content now.", "th_1", sel);
    expect(resolved.state).toBe("orphaned");
    expect(resolved.range).toBeNull();
  });

  test("short quotes never fuzzy-match", () => {
    const resolved = resolveThreadAnchor("abc abd abe", "th_1", {
      quote: { exact: "abz", prefix: "", suffix: "" },
    });
    expect(resolved.state).toBe("orphaned");
  });
});

describe("findInlineMarker", () => {
  test.for([
    { name: "simple marker", body: "text [T1](#thread-th_1) more", found: "[T1](#thread-th_1)" },
    { name: "no marker", body: "text without markers", found: null },
    { name: "different thread", body: "text [T1](#thread-th_2) more", found: null },
    { name: "label spanning lines is ignored", body: "text [bro\nken](#thread-th_1)", found: null },
    { name: "empty label", body: "[](#thread-th_1)", found: "[](#thread-th_1)" },
  ])("$name", ({ body, found }) => {
    const marker = findInlineMarker(body, "th_1");
    if (!found) expect(marker).toBeNull();
    else expect(body.slice(marker?.start, marker?.end)).toBe(found);
  });
});
