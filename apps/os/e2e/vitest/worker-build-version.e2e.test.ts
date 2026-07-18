import { expect, test } from "vitest";
import type { DynamicWorkerRef } from "../../src/domains/workers/schemas.ts";
import { inlineJsSource } from "./itx-test-support.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// Every dynamic worker sees its own build identity as
// env.ITERATE_WORKER_VERSION — the content-addressed key the loader caches
// by, so it changes exactly when the worker's source does. That contract is
// what makes it usable as a hosted processor registry's deploy version (a
// change resets the keepalive's crash-loop budget), so assert both halves:
// present and stable for one source, different for different source.
test("a dynamic worker's env carries its content-addressed build version", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = itx.projects.create({
    slug: `worker-version-${crypto.randomUUID().slice(0, 8)}`,
  });
  await project.projectId;

  const probeRef = (marker: string): DynamicWorkerRef => ({
    entrypoint: "VersionProbe",
    path: "/",
    source: inlineJsSource("probe.js", {
      "probe.js": `
          // ${marker}
          import { WorkerEntrypoint } from "cloudflare:workers";

          export class VersionProbe extends WorkerEntrypoint {
            async version() {
              return this.env.ITERATE_WORKER_VERSION;
            }
          }
        `,
    }),
    type: "stateless",
  });
  const probe = (marker: string) =>
    project.workers.get(probeRef(marker)) as unknown as {
      version(): Promise<unknown>;
    } & Disposable;

  using probeA = probe("source a");
  const versionA = await probeA.version();
  expect(versionA).toEqual(expect.stringMatching(/.+/));

  // Same source, same identity — the version is a pure function of the build.
  using probeARepeat = probe("source a");
  expect(await probeARepeat.version()).toBe(versionA);

  // A one-comment source change is a new build and a new version.
  using probeB = probe("source b");
  const versionB = await probeB.version();
  expect(versionB).toEqual(expect.stringMatching(/.+/));
  expect(versionB).not.toBe(versionA);
});
