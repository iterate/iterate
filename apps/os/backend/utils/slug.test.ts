import { describe, it, expect } from "vitest";
import { slugify, slugifyWithSuffix, isValidSlug } from "./slug.ts";

describe("slugify", () => {
  it("converts to lowercase", () => {
    expect(slugify("HELLO")).toBe("hello");
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("trims whitespace", () => {
    expect(slugify("  hello  ")).toBe("hello");
    expect(slugify("\thello\n")).toBe("hello");
  });

  it("replaces non-alphanumeric chars with hyphens", () => {
    expect(slugify("hello world")).toBe("hello-world");
    expect(slugify("hello_world")).toBe("hello-world");
    expect(slugify("hello@world")).toBe("hello-world");
    expect(slugify("hello!@#$%world")).toBe("hello-world");
  });

  it("forbids periods in slugs", () => {
    expect(slugify("hello.world")).toBe("hello-world");
    expect(slugify("v1.2.3")).toBe("v1-2-3");
    expect(slugify("my.project.name")).toBe("my-project-name");
    expect(slugify("file.txt")).toBe("file-txt");
  });

  it("collapses multiple hyphens", () => {
    expect(slugify("hello---world")).toBe("hello-world");
    expect(slugify("hello   world")).toBe("hello-world");
    expect(slugify("hello...world")).toBe("hello-world");
  });

  it("removes leading and trailing hyphens", () => {
    expect(slugify("-hello-")).toBe("hello");
    expect(slugify("---hello---")).toBe("hello");
    expect(slugify("@hello@")).toBe("hello");
  });

  it("truncates to 50 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBe(50);
    expect(slugify(long)).toBe("a".repeat(50));
  });

  it("returns 'unnamed' for empty or all-special-char input", () => {
    expect(slugify("")).toBe("unnamed");
    expect(slugify("   ")).toBe("unnamed");
    expect(slugify("@#$%")).toBe("unnamed");
    expect(slugify("...")).toBe("unnamed");
  });

  it("preserves numbers", () => {
    expect(slugify("project123")).toBe("project123");
    expect(slugify("123")).toBe("123");
    expect(slugify("v2")).toBe("v2");
  });

  it("handles unicode characters", () => {
    expect(slugify("café")).toBe("caf");
    expect(slugify("日本語")).toBe("unnamed");
    expect(slugify("hello世界")).toBe("hello");
  });
});

describe("slugifyWithSuffix", () => {
  it("appends a 6-character suffix", () => {
    const result = slugifyWithSuffix("test");
    expect(result).toMatch(/^test-[a-z0-9]{6}$/);
  });

  it("applies slugify rules to the base", () => {
    const result = slugifyWithSuffix("Hello World");
    expect(result).toMatch(/^hello-world-[a-z0-9]{6}$/);
  });

  it("forbids periods in base before adding suffix", () => {
    const result = slugifyWithSuffix("my.project");
    expect(result).toMatch(/^my-project-[a-z0-9]{6}$/);
  });

  it("generates unique suffixes", () => {
    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      results.add(slugifyWithSuffix("test"));
    }
    // With 36^6 possible values, 100 iterations should give unique results
    expect(results.size).toBe(100);
  });
});

describe("isValidSlug", () => {
  it("returns true for valid slugs", () => {
    expect(isValidSlug("hello")).toBe(true);
    expect(isValidSlug("hello-world")).toBe(true);
    expect(isValidSlug("project123")).toBe(true);
    expect(isValidSlug("a-b-c")).toBe(true);
  });

  it("returns false for slugs with periods", () => {
    expect(isValidSlug("hello.world")).toBe(false);
    expect(isValidSlug("v1.2.3")).toBe(false);
    expect(isValidSlug("file.txt")).toBe(false);
  });

  it("returns false for slugs with uppercase", () => {
    expect(isValidSlug("Hello")).toBe(false);
    expect(isValidSlug("HELLO")).toBe(false);
    expect(isValidSlug("helloWorld")).toBe(false);
  });

  it("returns false for slugs with special characters", () => {
    expect(isValidSlug("hello_world")).toBe(false);
    expect(isValidSlug("hello@world")).toBe(false);
    expect(isValidSlug("hello world")).toBe(false);
  });

  it("returns false for slugs with leading/trailing hyphens", () => {
    expect(isValidSlug("-hello")).toBe(false);
    expect(isValidSlug("hello-")).toBe(false);
    expect(isValidSlug("-hello-")).toBe(false);
  });

  it("returns false for slugs longer than 50 characters", () => {
    expect(isValidSlug("a".repeat(51))).toBe(false);
    expect(isValidSlug("a".repeat(50))).toBe(true);
  });

  it("returns false for empty strings", () => {
    expect(isValidSlug("")).toBe(false);
  });
});
