// context/stateless-context.test.ts — `itxEntrypointFor` mints one loopback stub per execution context.
import { expect, test, vi } from "vitest";
import { itxEntrypointFor } from "./stateless-context.ts";

test("one execution context mints one loopback stub per context and origin, and another execution context its own", () => {
  const mint = () => ({ exports: { ItxEntrypoint: vi.fn((options: unknown) => ({ options })) } });
  const request = mint();
  const ctx = request as unknown as ExecutionContext;
  const first = itxEntrypointFor(ctx, "prj_a.iterate/", "https://os.test");
  expect(itxEntrypointFor(ctx, "prj_a.iterate/", "https://os.test")).toBe(first);
  expect(itxEntrypointFor(ctx, "prj_a.iterate/x", "https://os.test")).not.toBe(first);
  expect(itxEntrypointFor(ctx, "prj_a.iterate/", null)).not.toBe(first);
  expect(request.exports.ItxEntrypoint).toHaveBeenCalledTimes(3);
  const another = mint() as unknown as ExecutionContext;
  expect(itxEntrypointFor(another, "prj_a.iterate/", "https://os.test")).not.toBe(first);
});
