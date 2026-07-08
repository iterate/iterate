// Guards the generated embed of itx-api.generated.ts: worker code ships the
// itx type surface to agents via ITX_TYPES_SOURCE, which must track the
// generated public api file exactly.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ITX_TYPES_SOURCE } from "./types-source.generated.ts";

test("types-source.generated.ts is fresh (pnpm generate:itx-types-source)", () => {
  const typesPath = fileURLToPath(new URL("./itx-api.generated.ts", import.meta.url));
  expect(ITX_TYPES_SOURCE).toBe(readFileSync(typesPath, "utf8"));
});
