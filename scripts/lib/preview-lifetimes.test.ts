import { expect, test } from "vitest";
import { PreviewLifetimes } from "./preview-lifetimes.ts";

test("starting a new attempt retires its predecessor; an old finalizer cannot retire the new group", async () => {
  const values = new Map<string, string>();
  const runs = new PreviewLifetimes({
    get: async (key) => values.get(key) || null,
    put: async (key, value) => {
      values.set(key, value);
    },
  });
  const old = { group: "2659/123/1", expiresAt: Date.now() + 60_000 };
  const current = { ...old, group: "2659/123/2" };
  await runs.begin(old);
  await runs.begin(current);
  await runs.retire(old.group);
  expect(values.get(`lifetime:group:${old.group}`)).toBe("retired");
  expect(values.has(`lifetime:group:${current.group}`)).toBe(false);
  expect(values.get("ci:current-lifetime-group")).toBe(current.group);
  await expect(runs.begin(old)).rejects.toThrow("Cannot restart");
  await expect(runs.begin({ ...current, expiresAt: current.expiresAt + 1 })).rejects.toThrow(
    "immutable",
  );
});
