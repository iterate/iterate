// library/boundary.test.ts — THE LIBRARY RULE, pinned: a library module takes `itx` and nothing else,
// so at runtime it may import only capnweb, cloudflare:workers, its siblings in this folder, and the
// one platform primitive it needs to be a handle (context/invoke-handle.ts). Type-only imports are
// free (they erase). Anything else — the stream, the DO, the fetch module, the rest of context/ —
// would make the module un-movable to userspace, which is the whole point of the tier.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const LIBRARY_DIR = new URL(".", import.meta.url).pathname;
const ALLOWED_RUNTIME_IMPORTS = new Set([
  "capnweb",
  "cloudflare:workers",
  "../context/invoke-handle.ts",
]);

describe("the library boundary", () => {
  const modules = readdirSync(LIBRARY_DIR).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  test("there are library modules", () => expect(modules.length).toBeGreaterThan(0));
  for (const file of modules)
    test(`${file} imports only capnweb, cloudflare:workers, its siblings, invoke-handle, and types`, () => {
      const source = readFileSync(join(LIBRARY_DIR, file), "utf8");
      const offenders: string[] = [];
      for (const match of source.matchAll(
        /^import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm,
      )) {
        const [, typeOnly, specifier] = match;
        if (typeOnly) continue;
        if (specifier.startsWith("./")) continue;
        if (!ALLOWED_RUNTIME_IMPORTS.has(specifier)) offenders.push(specifier);
      }
      expect(offenders).toEqual([]);
    });
});
