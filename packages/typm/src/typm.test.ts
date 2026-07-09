import { expect, test } from "vitest";
import { acquireTypes, type AcquireTypesInput } from "./typm.ts";

test("pulls only .d.ts files and package.json, pruning everything else", async () => {
  const registry = fakeRegistry({
    resolve: { "zod@^3.24.0": "3.24.1" },
    packages: {
      "zod@3.24.1": {
        packageJson: { name: "zod", version: "3.24.1", types: "./index.d.ts" },
        files: {
          "/index.d.ts": "export declare const z: unknown;",
          "/index.js": "module.exports = {};",
          "/lib/types.d.mts": "export {};",
          "/README.md": "# zod",
        },
      },
    },
  });

  const result = await acquireTypes(input(registry, { dependencies: { zod: "^3.24.0" } }));

  expect(Object.keys(result.files).sort()).toEqual([
    "/node_modules/zod/index.d.ts",
    "/node_modules/zod/lib/types.d.mts",
    "/node_modules/zod/package.json",
  ]);
  expect(result).toMatchObject({
    packages: [{ name: "zod", version: "3.24.1", fileCount: 3 }],
    warnings: [],
  });
});

test("resolves ranges through the registry, ignoring any lockfile notion", async () => {
  const registry = fakeRegistry({
    resolve: { "left-pad@~1.3.0": "1.3.9" },
    packages: {
      "left-pad@1.3.9": {
        packageJson: { name: "left-pad", version: "1.3.9" },
        files: { "/index.d.ts": "declare function leftPad(s: string): string;" },
      },
    },
  });

  const result = await acquireTypes(input(registry, { dependencies: { "left-pad": "~1.3.0" } }));

  expect(result.packages).toMatchObject([{ name: "left-pad", version: "1.3.9" }]);
  expect(registry.requests).toContain(
    "https://data.jsdelivr.com/v1/package/resolve/npm/left-pad@~1.3.0",
  );
});

test("falls back to a major-matched @types package when no types ship", async () => {
  const registry = fakeRegistry({
    resolve: { "react@^18.2.0": "18.3.1", "@types/react@18": "18.3.5" },
    packages: {
      "react@18.3.1": {
        packageJson: { name: "react", version: "18.3.1" },
        files: { "/index.js": "module.exports = require('./cjs/react.js');" },
      },
      "@types/react@18.3.5": {
        packageJson: { name: "@types/react", version: "18.3.5" },
        files: { "/index.d.ts": "export declare function createElement(): unknown;" },
      },
    },
  });

  const result = await acquireTypes(input(registry, { dependencies: { react: "^18.2.0" } }));

  expect(Object.keys(result.files).sort()).toEqual([
    "/node_modules/@types/react/index.d.ts",
    "/node_modules/@types/react/package.json",
  ]);
  // Major-matched (@types/react@18), NOT latest — a react 18 repo must not get react 19 types.
  expect(registry.requests).toContain(
    "https://data.jsdelivr.com/v1/package/resolve/npm/@types/react@18",
  );
  expect(registry.requests).not.toContain(
    "https://data.jsdelivr.com/v1/package/resolve/npm/@types/react@latest",
  );
});

test("@types fallback tries latest when no major-matched version exists", async () => {
  const registry = fakeRegistry({
    resolve: { "some-lib@^2.0.0": "2.1.0", "@types/some-lib@latest": "1.0.4" },
    packages: {
      "some-lib@2.1.0": {
        packageJson: { name: "some-lib", version: "2.1.0" },
        files: { "/index.js": "" },
      },
      "@types/some-lib@1.0.4": {
        packageJson: { name: "@types/some-lib", version: "1.0.4" },
        files: { "/index.d.ts": "export {};" },
      },
    },
  });

  const result = await acquireTypes(input(registry, { dependencies: { "some-lib": "^2.0.0" } }));

  expect(result.packages).toMatchObject([{ name: "@types/some-lib", version: "1.0.4" }]);
});

test("mangles scoped names for the @types fallback", async () => {
  const registry = fakeRegistry({
    resolve: { "@scoped/thing@^1.0.0": "1.2.0", "@types/scoped__thing@1": "1.2.3" },
    packages: {
      "@scoped/thing@1.2.0": {
        packageJson: { name: "@scoped/thing", version: "1.2.0" },
        files: { "/index.js": "" },
      },
      "@types/scoped__thing@1.2.3": {
        packageJson: { name: "@types/scoped__thing", version: "1.2.3" },
        files: { "/index.d.ts": "export {};" },
      },
    },
  });

  const result = await acquireTypes(
    input(registry, { dependencies: { "@scoped/thing": "^1.0.0" } }),
  );

  expect(Object.keys(result.files)).toContain("/node_modules/@types/scoped__thing/index.d.ts");
});

test("recurses into dependencies and non-optional peers, skipping optional peers", async () => {
  const registry = fakeRegistry({
    resolve: {
      "ui-lib@^1.0.0": "1.0.0",
      "helper@^2.0.0": "2.5.0",
      "framework@>=17": "18.0.0",
    },
    packages: {
      "ui-lib@1.0.0": {
        packageJson: {
          name: "ui-lib",
          version: "1.0.0",
          dependencies: { helper: "^2.0.0" },
          peerDependencies: { framework: ">=17", "optional-peer": "*" },
          peerDependenciesMeta: { "optional-peer": { optional: true } },
        },
        files: { "/index.d.ts": "export {};" },
      },
      "helper@2.5.0": {
        packageJson: { name: "helper", version: "2.5.0" },
        files: { "/index.d.ts": "export {};" },
      },
      "framework@18.0.0": {
        packageJson: { name: "framework", version: "18.0.0" },
        files: { "/index.d.ts": "export {};" },
      },
    },
  });

  const result = await acquireTypes(input(registry, { dependencies: { "ui-lib": "^1.0.0" } }));

  expect(result.packages.map((acquired) => acquired.name).sort()).toEqual([
    "framework",
    "helper",
    "ui-lib",
  ]);
  const resolveAttempts = registry.requests.filter((url) =>
    url.includes("/resolve/npm/optional-peer"),
  );
  expect(resolveAttempts).toEqual([]);
});

test("flat node_modules: first resolution per package name wins, no refetch", async () => {
  const registry = fakeRegistry({
    resolve: { "app-lib@^1.0.0": "1.0.0", "shared-dep@^3.0.0": "3.9.9" },
    packages: {
      "app-lib@1.0.0": {
        packageJson: {
          name: "app-lib",
          version: "1.0.0",
          // Wants an OLD major of shared-dep; the top-level (wave 0) v3 already won.
          dependencies: { "shared-dep": "^2.0.0" },
        },
        files: { "/index.d.ts": "export {};" },
      },
      "shared-dep@3.9.9": {
        packageJson: { name: "shared-dep", version: "3.9.9" },
        files: { "/index.d.ts": "export {};" },
      },
    },
  });

  const result = await acquireTypes(
    input(registry, { dependencies: { "app-lib": "^1.0.0", "shared-dep": "^3.0.0" } }),
  );

  expect(result.packages.map((acquired) => `${acquired.name}@${acquired.version}`).sort()).toEqual([
    "app-lib@1.0.0",
    "shared-dep@3.9.9",
  ]);
  const sharedDepResolves = registry.requests.filter((url) =>
    url.includes("/resolve/npm/shared-dep"),
  );
  expect(sharedDepResolves).toHaveLength(1);
});

test("terminates on circular dependencies", async () => {
  const registry = fakeRegistry({
    resolve: { "pkg-a@^1.0.0": "1.0.0", "pkg-b@^1.0.0": "1.0.0" },
    packages: {
      "pkg-a@1.0.0": {
        packageJson: { name: "pkg-a", version: "1.0.0", dependencies: { "pkg-b": "^1.0.0" } },
        files: { "/index.d.ts": "export {};" },
      },
      "pkg-b@1.0.0": {
        packageJson: { name: "pkg-b", version: "1.0.0", dependencies: { "pkg-a": "^1.0.0" } },
        files: { "/index.d.ts": "export {};" },
      },
    },
  });

  const result = await acquireTypes(input(registry, { dependencies: { "pkg-a": "^1.0.0" } }));

  expect(result.packages.map((acquired) => acquired.name).sort()).toEqual(["pkg-a", "pkg-b"]);
});

test("stops enqueueing past maxPackages with a warning", async () => {
  const registry = fakeRegistry({
    resolve: { "one@1": "1.0.0", "two@1": "1.0.0", "three@1": "1.0.0" },
    packages: {
      "one@1.0.0": {
        packageJson: { name: "one", version: "1.0.0" },
        files: { "/index.d.ts": "export {};" },
      },
      "two@1.0.0": {
        packageJson: { name: "two", version: "1.0.0" },
        files: { "/index.d.ts": "export {};" },
      },
      "three@1.0.0": {
        packageJson: { name: "three", version: "1.0.0" },
        files: { "/index.d.ts": "export {};" },
      },
    },
  });

  const result = await acquireTypes({
    ...input(registry, { dependencies: { one: "1", two: "1", three: "1" } }),
    limits: { maxPackages: 2, maxTotalBytes: 1024 * 1024 },
  });

  expect(result.packages).toHaveLength(2);
  expect(result.warnings.join("\n")).toContain("maxPackages");
});

test("skips a package whole when it would exceed the byte budget", async () => {
  const registry = fakeRegistry({
    resolve: { "small@1": "1.0.0", "huge@1": "1.0.0" },
    packages: {
      "small@1.0.0": {
        packageJson: { name: "small", version: "1.0.0" },
        files: { "/index.d.ts": "export {};" },
      },
      "huge@1.0.0": {
        packageJson: { name: "huge", version: "1.0.0" },
        files: { "/index.d.ts": "x".repeat(10_000) },
      },
    },
  });

  const result = await acquireTypes({
    ...input(registry, { dependencies: { small: "1", huge: "1" } }),
    // Room for small's 2 files (content + per-file overhead) but not huge's 10 kB.
    limits: { maxPackages: 100, maxTotalBytes: 5000 },
  });

  expect(result.packages.map((acquired) => acquired.name)).toEqual(["small"]);
  expect(result.warnings.join("\n")).toContain("byte budget");
  expect(Object.keys(result.files).some((path) => path.includes("huge"))).toBe(false);
});

test("the byte budget bounds request fan-out, not just content size", async () => {
  // A hostile flat listing: thousands of zero-size declaration files would
  // pass a content-only budget while triggering a fetch per file.
  const zeroSizeFiles = Object.fromEntries(
    Array.from({ length: 5000 }, (_, i) => [`/gen/file-${i}.d.ts`, ""]),
  );
  const registry = fakeRegistry({
    resolve: { "hostile@1": "1.0.0" },
    packages: {
      "hostile@1.0.0": {
        packageJson: { name: "hostile", version: "1.0.0" },
        files: zeroSizeFiles,
      },
    },
  });

  const result = await acquireTypes({
    ...input(registry, { dependencies: { hostile: "1" } }),
    limits: { maxPackages: 100, maxTotalBytes: 1024 * 1024 },
  });

  expect(result.packages).toEqual([]);
  expect(result.warnings.join("\n")).toContain("byte budget");
  const fileFetches = registry.requests.filter((url) => url.startsWith("https://cdn.jsdelivr.net"));
  expect(fileFetches).toEqual([]);
});

test("keeps nested package.json files (pre-exports subpath types routing)", async () => {
  const registry = fakeRegistry({
    resolve: { "old-style@^6.0.0": "6.6.6" },
    packages: {
      "old-style@6.6.6": {
        packageJson: { name: "old-style", version: "6.6.6" },
        files: {
          "/index.d.ts": "export {};",
          "/operators/package.json": '{ "types": "../typings/operators/index.d.ts" }',
          "/typings/operators/index.d.ts": "export declare const map: unknown;",
        },
      },
    },
  });

  const result = await acquireTypes(input(registry, { dependencies: { "old-style": "^6.0.0" } }));

  expect(Object.keys(result.files).sort()).toEqual([
    "/node_modules/old-style/index.d.ts",
    "/node_modules/old-style/operators/package.json",
    "/node_modules/old-style/package.json",
    "/node_modules/old-style/typings/operators/index.d.ts",
  ]);
});

test("skips unfetchable specifiers (workspace:/github:/file:) with warnings", async () => {
  const registry = fakeRegistry({
    resolve: { "normal@^1.0.0": "1.0.0" },
    packages: {
      "normal@1.0.0": {
        packageJson: { name: "normal", version: "1.0.0" },
        files: { "/index.d.ts": "export {};" },
      },
    },
  });

  const result = await acquireTypes(
    input(registry, {
      dependencies: {
        normal: "^1.0.0",
        local: "workspace:*",
        forked: "github:someone/forked#main",
        onDisk: "file:../on-disk",
      },
    }),
  );

  expect(result.packages).toMatchObject([{ name: "normal" }]);
  expect(result.warnings).toHaveLength(3);
});

test("unresolvable packages warn but never break the rest", async () => {
  const registry = fakeRegistry({
    resolve: { "real@^1.0.0": "1.0.0" },
    packages: {
      "real@1.0.0": {
        packageJson: { name: "real", version: "1.0.0" },
        files: { "/index.d.ts": "export {};" },
      },
    },
  });

  const result = await acquireTypes(
    input(registry, { dependencies: { real: "^1.0.0", "not-on-npm": "^9.9.9" } }),
  );

  expect(result.packages).toMatchObject([{ name: "real" }]);
  expect(result.warnings.join("\n")).toContain("not-on-npm");
  // The registry ANSWERED (404) — that's an honest "nothing here", not a
  // transient failure, so consumers must treat the result as authoritative
  // (the repo IDE worker evicts stale types on failures: 0, retries on > 0).
  expect(result).toMatchObject({ failures: 0 });
});

test("skips names outside npm's grammar before they reach a URL or vfs path", async () => {
  const registry = fakeRegistry({
    resolve: { "fine@^1.0.0": "1.0.0" },
    packages: {
      "fine@1.0.0": {
        packageJson: { name: "fine", version: "1.0.0" },
        files: { "/index.d.ts": "export {};" },
      },
    },
  });

  const result = await acquireTypes(
    input(registry, {
      dependencies: {
        fine: "^1.0.0",
        "../escape": "^1.0.0",
        "weird?query": "^1.0.0",
        "frag#ment": "^1.0.0",
        "with space": "^1.0.0",
      },
    }),
  );

  expect(result.packages).toMatchObject([{ name: "fine" }]);
  expect(result.warnings).toHaveLength(4);
  expect(result.warnings.join("\n")).toContain("not a valid npm package name");
  // Nothing invalid ever became a request or a vfs path.
  expect(registry.requests.filter((url) => !url.includes("fine"))).toEqual([]);
  expect(Object.keys(result.files)).toEqual([
    "/node_modules/fine/index.d.ts",
    "/node_modules/fine/package.json",
  ]);
});

test("a thrown fetch costs only its own package, not the whole wave", async () => {
  const registry = fakeRegistry({
    resolve: { "healthy@^1.0.0": "1.0.0", "flaky@^1.0.0": "1.0.0" },
    packages: {
      "healthy@1.0.0": {
        packageJson: { name: "healthy", version: "1.0.0" },
        files: { "/index.d.ts": "export {};" },
      },
      "flaky@1.0.0": {
        packageJson: { name: "flaky", version: "1.0.0" },
        files: { "/index.d.ts": "export {};" },
      },
    },
  });
  const flakyFetch = (url: string): Promise<Response> => {
    if (url.includes("flaky")) return Promise.reject(new Error("network blip"));
    return registry.fetch(url);
  };

  const result = await acquireTypes({
    ...input(registry, { dependencies: { healthy: "^1.0.0", flaky: "^1.0.0" } }),
    fetch: flakyFetch,
  });

  expect(result.packages).toMatchObject([{ name: "healthy" }]);
  expect(result.warnings.join("\n")).toContain("network blip");
  expect(Object.keys(result.files)).toContain("/node_modules/healthy/index.d.ts");
  // Thrown fetches (unlike answered 404s) count as transient-shaped failures.
  expect(result).toMatchObject({ failures: 1 });
});

test("includes devDependencies from the root package.json", async () => {
  const registry = fakeRegistry({
    resolve: { "@types/node@^25.0.0": "25.0.10" },
    packages: {
      "@types/node@25.0.10": {
        packageJson: { name: "@types/node", version: "25.0.10" },
        files: { "/index.d.ts": "declare var process: unknown;" },
      },
    },
  });

  const result = await acquireTypes(
    input(registry, { devDependencies: { "@types/node": "^25.0.0" } }),
  );

  expect(Object.keys(result.files)).toContain("/node_modules/@types/node/index.d.ts");
});

test("throws on unparseable root package.json", async () => {
  const registry = fakeRegistry({ resolve: {}, packages: {} });
  await expect(
    acquireTypes({ ...input(registry, {}), packageJson: "{ not json" }),
  ).rejects.toThrow();
});

// ---------------------------------------------------------------------------
// helpers

function input(registry: FakeRegistry, packageJson: Record<string, unknown>): AcquireTypesInput {
  return {
    packageJson: JSON.stringify(packageJson),
    fetch: registry.fetch,
    log: () => {},
    limits: { maxPackages: 100, maxTotalBytes: 1024 * 1024 },
  };
}

interface FakePackage {
  packageJson: Record<string, unknown>;
  files: Record<string, string>;
}

interface FakeRegistry {
  fetch: (url: string) => Promise<Response>;
  requests: string[];
}

/**
 * Serves the three jsdelivr endpoint shapes typm uses, from plain data:
 * - resolve: an EXPLICIT `name@range` → version map (no semver logic hiding
 *   in the fake — the test shows exactly which resolution question was asked)
 * - flat listings + file contents derived from `packages` ("name@version")
 */
function fakeRegistry(config: {
  resolve: Record<string, string>;
  packages: Record<string, FakePackage>;
}): FakeRegistry {
  const requests: string[] = [];
  const allFiles = (fake: FakePackage): Record<string, string> => ({
    ...fake.files,
    "/package.json": JSON.stringify(fake.packageJson),
  });

  const fetch = async (url: string): Promise<Response> => {
    requests.push(url);
    const resolveMatch = /^https:\/\/data\.jsdelivr\.com\/v1\/package\/resolve\/npm\/(.+)$/.exec(
      url,
    );
    if (resolveMatch) {
      const version = config.resolve[decodeURIComponent(resolveMatch[1]!)];
      return version
        ? Response.json({ version })
        : new Response("package not found", { status: 404 });
    }
    const flatMatch = /^https:\/\/data\.jsdelivr\.com\/v1\/package\/npm\/(.+)\/flat$/.exec(url);
    if (flatMatch) {
      const fake = config.packages[flatMatch[1]!];
      if (!fake) return new Response("version not found", { status: 404 });
      const files = Object.entries(allFiles(fake)).map(([name, content]) => ({
        name,
        size: content.length,
      }));
      return Response.json({ default: "/index.d.ts", files });
    }
    const fileMatch = /^https:\/\/cdn\.jsdelivr\.net\/npm\/([^/]+(?:\/[^/@]+)?@[^/]+)(\/.+)$/.exec(
      url,
    );
    if (fileMatch) {
      const fake = config.packages[fileMatch[1]!];
      const content = fake ? allFiles(fake)[fileMatch[2]!] : undefined;
      return content === undefined
        ? new Response("file not found", { status: 404 })
        : new Response(content);
    }
    throw new Error(`fakeRegistry: unexpected URL ${url}`);
  };

  return { fetch, requests };
}
