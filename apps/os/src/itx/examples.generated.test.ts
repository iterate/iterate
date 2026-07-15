// Guards the generated examples catalogue: examples.generated.ts must track
// the typed-function source module (examples-source.ts). When this fails,
// run `pnpm generate:itx-examples` and commit the result.
//
// The generator itself enforces the per-entry contract (block-bodied fn,
// plain-JS body, fn XOR code, known runtimes) — regenerating here means a
// violation in examples-source.ts fails THIS test with the generator's
// message, not just the freshness diff.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { generateItxExamples } from "../../scripts/generate-itx-examples.ts";
import { ITX_EXAMPLE_SOURCES } from "./examples-source.ts";
import { ITX_EXAMPLES } from "./examples.ts";

const generatedPath = fileURLToPath(new URL("./examples.generated.ts", import.meta.url));

test("examples.generated.ts is fresh (pnpm generate:itx-examples)", () => {
  expect(readFileSync(generatedPath, "utf8")).toBe(generateItxExamples());
}, 60_000);

test("every source entry ships: same ids, same order, code everywhere", () => {
  expect(ITX_EXAMPLES.map((example) => example.id)).toEqual(
    ITX_EXAMPLE_SOURCES.map((entry) => entry.id),
  );
  for (const example of ITX_EXAMPLES) {
    expect(example.code.length, `example ${example.id} has an empty body`).toBeGreaterThan(0);
  }
});
