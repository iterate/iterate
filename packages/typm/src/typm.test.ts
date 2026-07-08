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
    limits: { maxPackages: 100, maxTotalBytes: 1000 },
  });

  expect(result.packages.map((acquired) => acquired.name)).toEqual(["small"]);
  expect(result.warnings.join("\n")).toContain("byte budget");
  expect(Object.keys(result.files).some((path) => path.includes("huge"))).toBe(false);
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
