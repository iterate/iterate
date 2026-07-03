import { describe, expect, test } from "vitest";
import { startMockSlackApi } from "./itx-capability-fixtures.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

// The worker build pipeline end-to-end: multi-file TypeScript sources built
// through Cloudflare's bundler into the KV artifact cache, build lifecycle
// events on the ref's scope stream, and the seeded TypeScript template's
// userland Slack SDK surface. Split from the itx monolith: these tests pay a
// cold bundler run (npm installs included), so they earn their own file-level
// parallelism.
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
      // from a previous run, and this test asserts the COLD path's build
      // lifecycle events.
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

    // Build lifecycle is visible on the ref's scope stream: a requested event
    // carrying the inline file map, and a completed event carrying artifact
    // identity — module names, never module contents.
    const events = await project.streams.get("/").getEvents();
    const requested = events.find(
      (event) =>
        event.type === "events.iterate.com/worker-build/requested" &&
        (event.payload?.source as { files?: Record<string, string> } | undefined)?.files?.[
          "lib/math.ts"
        ] !== undefined,
    );
    expect(requested).toBeTruthy();
    const completed = events.find(
      (event) =>
        event.type === "events.iterate.com/worker-build/completed" &&
        event.payload?.buildKey === requested!.payload!.buildKey,
    );
    expect(completed).toBeTruthy();
    expect(completed!.payload).not.toHaveProperty("modules");
    expect(JSON.stringify(completed!.payload)).not.toContain("hello from bundled typescript");

    // Warm loads are cache hits: the same source resolves without a second
    // build request.
    expect(await worker.compute({ left: 1, right: 2 })).toEqual({
      greeting: "hello from bundled typescript",
      sum: 3,
    });
    const eventsAfter = await project.streams.get("/").getEvents();
    expect(
      eventsAfter.filter(
        (event) =>
          event.type === "events.iterate.com/worker-build/requested" &&
          event.payload?.buildKey === requested!.payload!.buildKey,
      ),
    ).toHaveLength(1);
  });

  // First use after the config commit is always a cold build (new contentHash)
  // including an npm install of @slack/web-api inside the bundler — give it
  // clear headroom over the resolver's own 120s build-wait timeout so a slow
  // registry surfaces as a build error, not an opaque vitest timeout.
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
});
