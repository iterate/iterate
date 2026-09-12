import { expect, test } from "vitest";
import type { DynamicWorkerRef } from "../../src/domains/workers/schemas.ts";
import { inlineJsSource } from "./itx-test-support.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// Every dynamic worker sees its own runtime identity as
// env.ITERATE_WORKER_VERSION — the content-addressed identity of what Worker
// Loader executes. It stays stable across an artifact rebuild with identical
// runtime modules, and changes for an executable or compatibility change.
test("a dynamic worker's env carries its content-addressed runtime version", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects
    .get(`worker-version-${crypto.randomUUID().slice(0, 8)}`)
    .create({});
  await project.projectId;

  const probeRef = (marker: string): DynamicWorkerRef => ({
    entrypoint: "VersionProbe",
    path: "/",
    source: inlineJsSource("probe.js", {
      "probe.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";

          export class VersionProbe extends WorkerEntrypoint {
            async version() {
              return [this.env.ITERATE_WORKER_VERSION, ${JSON.stringify(marker)}].join(":");
            }
          }
        `,
    }),
    type: "stateless",
  });
  const probe = (marker: string) =>
    project.workers.get(probeRef(marker)) as unknown as {
      version(): Promise<string>;
    } & Disposable;

  using probeA = probe("source a");
  const versionA = await probeA.version();
  expect(versionA).toBe("" + versionA);
  const [runtimeVersionA, markerA] = versionA.split(":");
  expect(runtimeVersionA).toMatch(/^[0-9a-f]{64}$/);
  expect(markerA).toBe("source a");

  // Same executable source, same runtime identity.
  using probeARepeat = probe("source a");
  expect(await probeARepeat.version()).toBe(versionA);

  // An executable string-literal change is a new runtime identity. A comment
  // would be dropped by bundling and would not prove this contract.
  using probeB = probe("source b");
  const versionB = await probeB.version();
  expect(versionB).toBe("" + versionB);
  const [runtimeVersionB, markerB] = versionB.split(":");
  expect(runtimeVersionB).toMatch(/^[0-9a-f]{64}$/);
  expect(markerB).toBe("source b");
  expect(runtimeVersionB).not.toBe(runtimeVersionA);
});
