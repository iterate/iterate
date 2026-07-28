import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const headersFile = fileURLToPath(new URL("../public/_headers", import.meta.url));

describe("static asset browser caching", () => {
  it("caches fingerprinted Vite assets immutably without caching SSR documents", () => {
    expect(readFileSync(headersFile, "utf8").trim()).toBe(
      ["/assets/*", "  Cache-Control: public, max-age=31556952, immutable"].join("\n"),
    );
  });
});
