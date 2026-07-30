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
import { expect, test, vi } from "vitest";
import { generateItxExamples } from "../../scripts/generate-itx-examples.ts";
import { ITX_EXAMPLE_SOURCES } from "./examples-source.ts";
import { ITX_EXAMPLES } from "./examples.ts";

// Generated catalogue entries are script bodies, so this mirrors the runtime
// door that supplies `itx` and `vars` as parameters.
const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

test("examples.generated.ts is fresh (pnpm generate:itx-examples)", () => {
  expect(
    readFileSync(fileURLToPath(new URL("./examples.generated.ts", import.meta.url)), "utf8"),
  ).toBe(generateItxExamples());
}, 60_000);

test("every source entry ships: same ids, same order, code everywhere", () => {
  expect(ITX_EXAMPLES.map((example) => example.id)).toEqual(
    ITX_EXAMPLE_SOURCES.map((entry) => entry.id),
  );
  for (const example of ITX_EXAMPLES) {
    expect(example.code.length, `example ${example.id} has an empty body`).toBeGreaterThan(0);
  }
});

test("the ephemeral example keys every append for lifecycle-safe replay", async () => {
  const example = ITX_EXAMPLES.find((candidate) => candidate.id === "ephemeral-events");
  expect(example).toBeDefined();

  const events: Array<Record<string, unknown> & { offset: number }> = [];
  const append = vi.fn(async (event: Record<string, unknown>) => {
    const committed = { ...event, offset: events.length + 1 };
    events.push(committed);
    return [committed];
  });
  const getEvents = vi.fn(async (options?: { includeEphemeral?: boolean }) =>
    options?.includeEphemeral ? events : events.filter((event) => event.ephemeral !== true),
  );
  const run = new AsyncFunction("itx", "vars", example!.code);

  await run(
    {
      streams: {
        get: () => ({ append, getEvents }),
      },
    },
    { path: "/test/ephemeral" },
  );

  const [tick, done] = append.mock.calls.map(([event]) => event);
  expect(tick).toMatchObject({
    ephemeral: true,
    idempotencyKey: expect.stringMatching(/^ephemeral-events:.+:progress-ticked$/),
  });
  expect(done).toMatchObject({
    idempotencyKey: expect.stringMatching(/^ephemeral-events:.+:work-completed$/),
  });
  expect(String(tick!.idempotencyKey).replace(/:progress-ticked$/, "")).toBe(
    String(done!.idempotencyKey).replace(/:work-completed$/, ""),
  );
});
