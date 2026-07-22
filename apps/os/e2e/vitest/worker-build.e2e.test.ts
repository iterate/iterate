import { expect, test } from "vitest";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// The complete native path: source values cross the compiler sidecar, the
// resulting loader-ready modules enter the immutable artifact cache, and
// Worker Loader starts them. No container or filesystem checkout is involved.
test("Worker build pipeline bundles multi-file TypeScript inline sources", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`ts-inline-build-${crypto.randomUUID()}`).create({});

  const inlineTsFiles = {
    // Salted per run so this test proves a cold build instead of finding an
    // artifact left by a previous run.
    "worker.ts": `
        import { WorkerEntrypoint } from "cloudflare:workers";
        import { add, GREETING } from "./lib/math.ts";

        // build salt ${crypto.randomUUID()}
        export class TsEntrypoint extends WorkerEntrypoint {
          compute(input: { left: number; right: number }): { greeting: string; sum: number } {
            return { greeting: GREETING, sum: add(input.left, input.right) };
          }
        }
      `,
    "lib/math.ts": `
        export const GREETING: string = "hello from bundled typescript";

        export function add(left: number, right: number): number {
          return left + right;
        }
      `,
  };
  using worker = project.workers.get({
    entrypoint: "TsEntrypoint",
    path: "/",
    source: {
      createWorker: {
        entryPoint: "worker.ts",
        files: { files: inlineTsFiles, type: "inline" },
      },
    },
    type: "stateless",
  }) as unknown as {
    compute(input: { left: number; right: number }): Promise<{ greeting: string; sum: number }>;
  } & Disposable;

  expect(await worker.compute({ left: 20, right: 22 })).toEqual({
    greeting: "hello from bundled typescript",
    sum: 42,
  });

  // Build inputs and outputs are not journal events.
  const events = await project.streams.get("/").getEvents();
  expect(JSON.stringify(events)).not.toContain("hello from bundled typescript");

  // The same immutable source resolves through the warm artifact path.
  expect(await worker.compute({ left: 1, right: 2 })).toEqual({
    greeting: "hello from bundled typescript",
    sum: 3,
  });
});

test("Worker builds let worker-bundler install and bundle package dependencies", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`dependency-build-${crypto.randomUUID()}`).create({});
  using worker = project.workers.get({
    entrypoint: "Probe",
    path: "/",
    source: {
      createWorker: {
        entryPoint: "worker.ts",
        files: {
          files: {
            "package.json": JSON.stringify({ dependencies: { "lodash-es": "4.17.21" } }),
            "worker.ts": [
              'import { WorkerEntrypoint } from "cloudflare:workers";',
              'import { camelCase } from "lodash-es";',
              "export class Probe extends WorkerEntrypoint { format(value: string) { return camelCase(value); } }",
              `// build salt ${crypto.randomUUID()}`,
            ].join("\n"),
          },
          type: "inline",
        },
      },
    },
    type: "stateless",
  }) as unknown as { format(value: string): Promise<string> } & Disposable;

  await expect(worker.format("hello worker bundler")).resolves.toBe("helloWorkerBundler");
});
