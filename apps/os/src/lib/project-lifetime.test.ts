import { expect, test, vi } from "vitest";
import { primeProjectDirectory } from "../project-directory.ts";
import { ProjectLifetime } from "./project-lifetime.ts";

test("a retired group stops its projects, while other groups and persistent projects keep running", async () => {
  const directory = memoryDirectory();
  for (const [id, lifetime] of [
    ["old", { group: "batch-1", expiresAt: Date.now() + 60_000 }],
    ["new", { group: "batch-2", expiresAt: Date.now() + 60_000 }],
    ["human", undefined],
  ] as const) {
    await primeProjectDirectory(directory, {
      id,
      slug: id,
      name: id,
      organizationId: null,
      metadata: lifetime ? { lifetime } : {},
    });
  }
  const old = new ProjectLifetime(memoryStorage(), directory, "old");
  const current = new ProjectLifetime(memoryStorage(), directory, "new");
  const human = new ProjectLifetime(memoryStorage(), directory, "human");
  expect(await old.hasExpired()).toBe(false);
  await directory.put("lifetime:group:batch-1", "retired");
  expect(await old.hasExpired()).toBe(true);
  expect(await current.hasExpired()).toBe(false);
  expect(await human.hasExpired()).toBe(false);
});

test("a deadline still expires after directory loss, and retirement survives eviction", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1_000);
    const directory = memoryDirectory();
    await primeProjectDirectory(directory, {
      id: "demo",
      slug: "demo",
      name: "Demo",
      organizationId: null,
      metadata: { lifetime: { expiresAt: 2_000 } },
    });
    const storage = memoryStorage();
    expect(await new ProjectLifetime(storage, directory, "demo").hasExpired()).toBe(false);
    await directory.delete("project:demo");
    vi.setSystemTime(2_000);
    expect(await new ProjectLifetime(storage, directory, "demo").hasExpired()).toBe(true);
    vi.setSystemTime(1_000); // Neither a stale read nor a clock correction revives work.
    expect(await new ProjectLifetime(storage, directory, "demo").hasExpired()).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

function memoryDirectory(): any {
  const values = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const value = values.get(key);
      return value ? (type === "json" ? JSON.parse(value) : value) : null;
    },
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };
}

function memoryStorage(): any {
  const values = new Map();
  return {
    get: (key: string) => values.get(key),
    put: (key: string, value: unknown) => values.set(key, value),
  };
}
