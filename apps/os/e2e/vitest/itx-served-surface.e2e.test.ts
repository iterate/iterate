import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import { connectItx } from "iterate/node";
import type { RpcStub } from "iterate/sdk/capnweb";
import type { Agent, Project, StreamEventBatch } from "../../src/itx-api.generated.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { AGENT_CONTEXT_ADDED_TYPE } from "./itx-test-support.ts";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

const VISITOR_AGENT_PATH = "/agents/web/visitor";

/**
 * The REAL `serveItx` (packages/iterate/src/serve-itx.ts), committed into the
 * project repo next to a tiny worker: the seeded project installs the
 * published `iterate` package, which predates the helper, so its relative
 * imports are rewritten to the published entry points and the one new
 * platform member (`Project.scope`) is reached through a cast. What this
 * proves is the crossing the helper exists for: a scoped itx minted inside
 * the worker, relayed through the worker's Cap'n Web session to the STOCK
 * client, and driven from there — calls, a live connection callback, and a
 * removed member.
 */
const SERVE_ITX_SOURCE = readFileSync(
  new URL("../../../../packages/iterate/src/serve-itx.ts", import.meta.url),
  "utf8",
)
  .replace('from "./sdk/capnweb/index.ts"', 'from "iterate/sdk/capnweb"')
  .replace('from "./itx-api.generated.ts"', 'from "iterate/sdk"')
  .replace(
    "const scoped = options.project.scope(options.scope);",
    "const scoped = (options.project as unknown as { scope(input: unknown): unknown }).scope(options.scope);",
  );

const SERVED_ITX_WORKER = `
import { IterateWorkerEntrypoint } from "iterate/sdk";
import { serveItx } from "./serve-itx.ts";

export default class ProjectWorker extends IterateWorkerEntrypoint {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/api") return new Response("served-itx worker");
    return await serveItx(req, {
      project: await this.env.ITX.get(),
      scope: {
        path: ${JSON.stringify(VISITOR_AGENT_PATH)},
        surface: ["agent.message", "agent.stream.getEvents", "agent.stream.openConnection"],
      },
    });
  }
}
`;

test(
  "a project worker serves a narrowed itx over its own /api to the stock client",
  { timeout: 240_000 },
  async () => {
    const slug = uniqueFixtureSlug("served-itx");
    using session = withItxSession();
    using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
    using project = await itx.projects.get(slug).create({});
    await project.__describe();
    using agent = project.agents.get(VISITOR_AGENT_PATH);
    await agent.create();
    await project.repo.commitFiles({
      changes: [
        { content: SERVE_ITX_SOURCE, path: "serve-itx.ts" },
        { content: SERVED_ITX_WORKER, path: "worker.ts" },
      ],
      message: "Serve a narrowed itx over /api",
    });

    // The project's ROOT host, dialed with the stock node client — the same
    // authenticate → projects.get handshake the browser session keeper runs.
    // Locally the host rides the handshake's Host header (nothing resolves
    // *.localhost); against a deployed preview the wildcard hostname is real.
    const base = new URL(buildUrl({ path: "/" }));
    const isLocal = base.hostname === "localhost" || base.hostname.endsWith(".localhost");
    const raw = process.env.APP_CONFIG_PROJECT_HOSTNAME_BASES?.trim();
    const configuredBase = raw ? String((JSON.parse(raw) as string[])[0]) : undefined;
    const previewMatch = /^os\.(iterate-preview-\d+)\.com$/.exec(base.hostname);
    const projectBase = configuredBase || (previewMatch ? `${previewMatch[1]}.app` : base.hostname);
    const auth = { type: "admin-secret" as const, secret: "not authority on a served itx" };
    const dial = (): RpcStub<Project> =>
      isLocal
        ? connectItx({
            auth,
            baseUrl: base.origin,
            headers: { host: `${slug}.localhost${base.port ? `:${base.port}` : ""}` },
            projectId: slug,
          })
        : connectItx({ auth, baseUrl: `https://${slug}.${projectBase}`, projectId: slug });

    // The first dial waits out the worker's cold build (ingress answers
    // upgrades with a retryable 503 until the artifact lands).
    let served: RpcStub<Project> | undefined;
    const deadline = Date.now() + 180_000;
    for (;;) {
      const candidate = dial();
      try {
        await candidate.__describe();
        served = candidate;
        break;
      } catch (error) {
        candidate[Symbol.dispose]?.();
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
    try {
      const description = await served.__describe();
      expect(Object.keys(description.children)).toEqual(["agent"]);
      expect(description.instructions).toContain("RESTRICTED scope");

      // A call through the served itx lands on the stream with the scope's
      // own principal, seen here through the admin session.
      const visitor = (served as unknown as { agent: Agent }).agent;
      await visitor.message("hello through the served itx");
      const added = (await agent.stream.getEvents({ eventTypes: [AGENT_CONTEXT_ADDED_TYPE] })).find(
        (event) =>
          (event.payload as { content?: string }).content === "hello through the served itx",
      );
      expect(added?.payload).toMatchObject({
        role: "user",
        actor: { type: "user", origin: "web", userId: `scope:${VISITOR_AGENT_PATH}` },
      });

      // A live connection through the served itx: the client's callback
      // crosses Cap'n Web into the worker and Workers RPC into the stream —
      // replay first, then a message sent AFTER the connection opened.
      const seen: string[] = [];
      const handle = await visitor.stream.openConnection({
        processEventBatch: (batch: StreamEventBatch) => {
          for (const event of batch.events) {
            seen.push(`${event.offset}:${(event.payload as { content?: string }).content ?? ""}`);
          }
        },
        replayAfterOffset: 0,
      });
      try {
        await waitForCondition(
          () => seen.some((entry) => entry.endsWith(":hello through the served itx")),
          {
            description: "replayed context item through the served connection",
            timeoutMs: 15_000,
          },
        );
        await visitor.message("a second message, live");
        await waitForCondition(
          () => seen.some((entry) => entry.endsWith(":a second message, live")),
          {
            description: "live context item through the served connection",
            timeoutMs: 15_000,
          },
        );
      } finally {
        await handle.close();
      }

      // A member the surface does not list does not exist on the served
      // project at all — the relay never dials the platform for it.
      await expect(
        (served as unknown as { agent: { kill(): Promise<void> } }).agent.kill(),
      ).rejects.toThrow(/'agent\.kill' is not a function/);
    } finally {
      served[Symbol.dispose]?.();
    }
  },
);
