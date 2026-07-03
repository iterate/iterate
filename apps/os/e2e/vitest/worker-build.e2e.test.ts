import { describe, expect, test } from "vitest";
import { startMockSlackApi } from "./itx-capability-fixtures.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// The worker build pipeline end-to-end: multi-file TypeScript sources built
// by the builder worker into the KV artifact cache, then the seeded
// TypeScript template's userland Slack SDK surface. Split from the itx
// monolith: these tests pay a cold bundler run (npm installs included), so
// they earn their own file-level parallelism.
describe("worker builds", () => {
  test("Worker build pipeline bundles multi-file TypeScript inline sources", async () => {
    using session = withItxSession();
    using itx = session.authenticate({
      type: "admin-secret",
      secret: adminSecret(),
    });
    using project = itx.projects.create({ slug: `ts-inline-build-${crypto.randomUUID()}` });

    const inlineTsFiles = {
      // Salted per run: an unsalted source would be a warm artifact-cache hit
      // from a previous run, and this test wants to prove the COLD build path.
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
        files: { files: inlineTsFiles, type: "inline" },
        options: { entryPoint: "worker.ts" },
      },
      type: "stateless",
    }) as unknown as {
      compute(input: { left: number; right: number }): Promise<{ greeting: string; sum: number }>;
    } & Disposable;

    expect(await worker.compute({ left: 20, right: 22 })).toEqual({
      greeting: "hello from bundled typescript",
      sum: 42,
    });

    // Builds do not touch the journal (coordination is a direct RPC to the
    // builder worker) — in particular, no journal event may ever carry the
    // worker's source or built modules.
    const events = await project.streams.get("/").getEvents();
    expect(JSON.stringify(events)).not.toContain("hello from bundled typescript");

    // A warm second call returns the same result from the cached artifact.
    expect(await worker.compute({ left: 1, right: 2 })).toEqual({
      greeting: "hello from bundled typescript",
      sum: 3,
    });
  });

  // First use after the config commit is always a cold build (new contentHash)
  // including an npm install of @slack/web-api inside the bundler — give it
  // generous headroom so a slow registry surfaces as a build error, not an
  // opaque vitest timeout.
  test(
    "Default project worker exposes the real Slack SDK as itx.worker.slack",
    { timeout: 240_000 },
    async () => {
      const mock = await startMockSlackApi();
      try {
        using session = withItxSession();
        using itx = session.authenticate({
          type: "admin-secret",
          secret: adminSecret(),
        });
        using project = itx.projects.create({ slug: `slack-worker-${crypto.randomUUID()}` });

        // The Slack surface is USERLAND: worker.ts constructs a real
        // @slack/web-api WebClient (installed from the seeded package.json by
        // the build pipeline) from the committed slack.config.ts. Point it at
        // the mock; the branch head moves, so the next worker use rebuilds.
        await project.repo.commitFiles({
          changes: [
            {
              path: "slack.config.ts",
              content: [
                "export const slackConfig: { slackApiUrl: string | null; token: string | null } = {",
                `  slackApiUrl: ${JSON.stringify(mock.url)},`,
                '  token: "xoxb-e2e-test-token",',
                "};",
                "",
              ].join("\n"),
            },
          ],
          message: "Point the Slack SDK at the e2e mock",
        });

        // @ts-expect-error - Cap'n Web stub typing flattens the nested surface.
        const posted = await project.worker.slack.chat.postMessage({
          channel: "C123",
          text: "hi from the project worker",
        });
        expect(posted).toMatchObject({
          channel: "C123",
          message: { text: "hi from the project worker" },
          ok: true,
          via: "mock-slack-api",
        });

        // Any nested Web API family resolves — nothing slack-specific is
        // enumerated in the worker.
        // @ts-expect-error - Cap'n Web stub typing flattens the nested surface.
        const users = await project.worker.slack.users.list();
        expect(users).toMatchObject({
          members: [
            { id: "U1", name: "ada" },
            { id: "U2", name: "grace" },
          ],
          ok: true,
          via: "mock-slack-api",
        });

        // Call capture only exists in local mode; deployed runs use the
        // deployment's own slack fixture and assert by response body above.
        if (mock.calls.length > 0) {
          expect(mock.calls).toEqual(expect.arrayContaining(["chat.postMessage", "users.list"]));
        }
      } finally {
        await mock.close();
      }
    },
  );

  // Stale-while-rebuild is availability-over-freshness BY EXPLICIT CHOICE on
  // the ref; the default "block" policy (commit-then-call sees new code) is
  // covered by the itx suite's repo-backed worker tests.
  test(
    "Stateful stale-while-rebuild serves the running version during a rebuild, then swaps",
    { timeout: 240_000 },
    async () => {
      using session = withItxSession();
      using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
      using project = itx.projects.create({ slug: `swr-${crypto.randomUUID().slice(0, 8)}` });
      await project.describe();

      const versionSource = (version: string) => [
        'import { DurableObject } from "cloudflare:workers";',
        "export class SwrProbe extends DurableObject {",
        `  version() { return ${JSON.stringify(version)}; }`,
        "}",
        `// salt ${crypto.randomUUID()}`,
      ];
      await project.repo.commitFiles({
        changes: [{ path: "swr/probe.ts", content: versionSource("v1").join("\n") }],
        message: "swr probe v1",
      });

      using probe = project.workers.get({
        className: "SwrProbe",
        durableWorkerKey: `swr-${crypto.randomUUID().slice(0, 8)}`,
        path: "/",
        source: {
          files: { include: ["swr/**"], repoPath: "/", type: "repo" },
          options: { entryPoint: "swr/probe.ts" },
        },
        type: "stateful",
        updatePolicy: "stale-while-rebuild",
      }) as unknown as { version(): Promise<string> } & Disposable;

      // First call: no previous version exists, so SWR falls through to a
      // blocking build of v1.
      expect(await probe.version()).toBe("v1");

      await project.repo.commitFiles({
        changes: [{ path: "swr/probe.ts", content: versionSource("v2").join("\n") }],
        message: "swr probe v2",
      });

      // Immediately after the commit the running version keeps answering (the
      // whole point of the policy) while the rebuild runs in the background...
      expect(await probe.version()).toBe("v1");

      // ...and the facet swaps once the fresh artifact lands.
      const deadline = Date.now() + 120_000;
      for (;;) {
        const version = await probe.version();
        if (version === "v2") break;
        if (Date.now() > deadline) throw new Error("stale-while-rebuild never swapped to v2");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    },
  );
});
