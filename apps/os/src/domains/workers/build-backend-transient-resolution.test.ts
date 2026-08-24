// Reproifies a live incident (preview-13, project pr2512, 2026-08-24 ~19:55 UTC):
// project creation failed terminally with "Default project worker bootstrap
// failed: Could not resolve version for @tanstack/query-core@5.102.3". A freshly
// published @tanstack/react-query exactly-pins query-core@5.102.3, and the
// bootstrap ran inside the npm publish-propagation window before query-core
// reached the bundler's registry endpoint. Minutes later the same version
// resolved fine — a fresh project on the same slot bootstrapped cleanly.
//
// Template builds are lockfile-less, so EVERY project bootstrap resolves latest
// at build time and is exposed to this race. build-backend.ts deliberately
// fails loudly on the unresolved-version warning shape
// (DEPENDENCY_INSTALL_FAILURE_WARNING_PATTERNS) — that loud failure is correct
// and must stay. The gap: a TRANSIENT resolution failure is treated as terminal
// with no retry, so a registry-propagation blip permanently kills the project.
//
// Desired behavior asserted here (false today, hence test.fails): a
// dependency-version-resolution failure that succeeds on a prompt retry does
// not kill the build — the build backend retries the install/bundle at least
// once and returns the usable artifact. (One retry is a placeholder; the exact
// retry policy is the fix's decision.) Genuine persistent failures must still
// fail loudly after retries — see the companion assertion at the bottom.
import { expect, test } from "vitest";
import { executeWorkerBuild } from "./build-backend.ts";

test.fails("DESIRED: a transient registry-propagation failure is retried instead of killing the build", async () => {
  // Controllable fake bundler: the first install hits the propagation window,
  // the second (what a prompt retry would see) succeeds.
  const attempts: number[] = [];
  const workerBundler = {
    createApp: async (): Promise<never> => {
      throw new Error("createApp should not be called");
    },
    createWorker: async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length === 1) {
        return {
          result: {
            mainModule: "bundle.js",
            modules: { "bundle.js": 'export * from "@tanstack/react-query";' },
            warnings: ["Could not resolve version for @tanstack/query-core@5.102.3"],
          },
        };
      }
      return {
        result: {
          mainModule: "bundle.js",
          modules: { "bundle.js": "export default {};" },
          warnings: [],
        },
      };
    },
  };

  const result = await executeWorkerBuild({
    files: {
      "package.json": JSON.stringify({
        dependencies: { "@tanstack/react-query": "latest" },
      }),
      "worker.ts": 'export * from "@tanstack/react-query";',
    },
    source: {
      createWorker: {
        entryPoint: "worker.ts",
        files: { files: { "worker.ts": "source" }, type: "inline" },
      },
    },
    workerBundler,
  });

  // The build backend retried past the transient blip and produced a usable
  // artifact. Today attempts is [1] and result is {ok: false} — the first
  // unresolved-version warning is terminal.
  expect(attempts.length).toBeGreaterThanOrEqual(2);
  expect(result).toMatchObject({
    ok: true,
    output: { mainModule: "bundle.js", warnings: [] },
  });
});

test("a persistent resolution failure still fails loudly", async () => {
  // The loud-failure property must survive the retry fix: when every attempt
  // emits the unresolved-version warning, the build fails with that message.
  const workerBundler = {
    createApp: async (): Promise<never> => {
      throw new Error("createApp should not be called");
    },
    createWorker: async () => ({
      result: {
        mainModule: "bundle.js",
        modules: { "bundle.js": 'export * from "@tanstack/react-query";' },
        warnings: ["Could not resolve version for @tanstack/query-core@5.102.3"],
      },
    }),
  };

  await expect(
    executeWorkerBuild({
      files: { "worker.ts": 'export * from "@tanstack/react-query";' },
      source: {
        createWorker: {
          entryPoint: "worker.ts",
          files: { files: { "worker.ts": "source" }, type: "inline" },
        },
      },
      workerBundler,
    }),
  ).resolves.toMatchObject({
    failure: {
      kind: "source",
      message: "Could not resolve version for @tanstack/query-core@5.102.3",
    },
    ok: false,
  });
});
