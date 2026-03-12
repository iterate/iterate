import assert from "node:assert/strict";
import test from "node:test";
import { FUNNY_SLUG_WORDS, makeFunnySlug } from "./slug-maker.ts";

test("FUNNY_SLUG_WORDS contains exactly 200 unique words", () => {
  assert.equal(FUNNY_SLUG_WORDS.length, 200);
  assert.equal(new Set(FUNNY_SLUG_WORDS).size, 200);
});

test("FUNNY_SLUG_WORDS excludes obvious technology terms", () => {
  for (const forbiddenWord of [
    "api",
    "app",
    "bash",
    "git",
    "java",
    "json",
    "linux",
    "node",
    "python",
    "redis",
    "script",
    "server",
    "socket",
    "sql",
    "tcp",
    "udp",
    "yaml",
  ]) {
    assert.equal(
      FUNNY_SLUG_WORDS.includes(forbiddenWord),
      false,
      `${forbiddenWord} should be excluded`,
    );
  }
});

test("makeFunnySlug returns three lowercase hyphenated words from the inventory", () => {
  const slug = makeFunnySlug();
  const parts = slug.split("-");

  assert.match(slug, /^[a-z0-9-]+$/);
  assert.equal(parts.length, 3);

  for (const part of parts) {
    assert.ok(FUNNY_SLUG_WORDS.includes(part), `${part} should come from the funny slug inventory`);
  }

  assert.equal(new Set(parts).size, parts.length);
});

test("makeFunnySlug produces more than one value across repeated calls", () => {
  const values = new Set(Array.from({ length: 50 }, () => makeFunnySlug()));
  assert.ok(values.size > 1);
});
