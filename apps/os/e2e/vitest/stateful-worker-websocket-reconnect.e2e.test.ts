import { once } from "node:events";
import { expect, test } from "vitest";
import NodeWebSocket from "ws";
import { newWebSocketRpcSession } from "capnweb";
import type { StatefulDynamicWorkerRef } from "iterate/sdk";
import type { DynamicWorkerCapability } from "../../src/domains/workers/schemas.ts";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, buildUrl, withItxSession } from "./test-helpers.ts";

test("stateful app reconnects without resetting an unchanged live SQLite worker", async () => {
  using session = withItxSession();
  using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
  using project = await itx.projects.get(`ws-reconnect-${crypto.randomUUID()}`).create({});
  const { projectId } = await project.__describe();
  const appSource = `
    import { IterateDurableObject } from "iterate/sdk";
    import { RpcTarget, newWorkersWebSocketRpcResponse } from "iterate/sdk/capnweb";
    export class ReconnectApp extends IterateDurableObject {
      instance = crypto.randomUUID();
      constructor(ctx, env) {
        super(ctx, env);
        ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
        ctx.storage.sql.exec("INSERT OR IGNORE INTO counter VALUES (1, 0)");
      }
      getState() {
        return { version: "one", instance: this.instance, value: this.ctx.storage.sql.exec("SELECT value FROM counter WHERE id = 1").one().value };
      }
      increment() {
        this.ctx.storage.sql.exec("UPDATE counter SET value = value + 1 WHERE id = 1");
        return this.getState();
      }
      fetch(request) {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return new Response("<!doctype html><html><head><title>Reconnect probe</title></head><body>Counter</body></html>", { headers: { "content-type": "text/html" } });
        }
        return newWorkersWebSocketRpcResponse(request, new Api(this));
      }
    }
    class Api extends RpcTarget {
      #app;
      constructor(app) { super(); this.#app = app; }
      getState() { return this.#app.getState(); }
      increment() { return this.#app.increment(); }
    }
  `;
  const ref = {
    type: "stateful",
    className: "ReconnectApp",
    durableWorkerKey: "test-reconnect",
    path: "/",
    source: {
      createWorker: {
        entryPoint: "app.ts",
        files: {
          type: "repo",
          repoPath: "/repos/config",
          include: ["package.json", "app.ts"],
        },
      },
    },
  } satisfies StatefulDynamicWorkerRef;
  const commit = await project.repo.commitFiles({
    message: "Install the isolated stateful WebSocket reconnect probe",
    changes: [
      { path: "app.ts", content: appSource },
      {
        path: "worker.ts",
        content: `
        import { IterateWorkerEntrypoint } from "iterate/sdk";
        export default class ProjectWorker extends IterateWorkerEntrypoint {
          fetch(request) {
            const headers = new Headers(request.headers);
            headers.set("x-iterate-worker-dispatch", JSON.stringify({ ref: ${JSON.stringify(ref)}, buildBudgetMs: 15000 }));
            return this.env.ITX.fetch(new Request(request, { headers }));
          }
        }
      `,
      },
    ],
  });
  await waitForCondition(
    async () => {
      const events = await project.streams.get("/").getEvents({ afterOffset: 0 });
      return events.some(
        (event) =>
          event.type === "events.iterate.com/project/worker-updated" &&
          event.payload?.commitOid === commit.commitOid,
      );
    },
    {
      description: "the probe's project worker deployment",
      // The setup includes a real source build; socket assertions below never retry.
      timeoutMs: 60_000,
    },
  );

  using worker = project.workers.get(ref) as unknown as DynamicWorkerCapability<{
    getState(): { instance: string; value: number; version: string };
  }>;
  expect(await worker.getState()).toMatchObject({ value: 0 });

  const url = buildUrl({ path: `/${projectId}/api`, protocol: "ws" });
  const sockets: NodeWebSocket[] = [];
  async function connect() {
    const page = await fetch(buildUrl({ path: `/${projectId}/` }));
    expect(page).toMatchObject({ status: 200 });
    expect(await page.text()).toContain("Reconnect probe");
    const socket = new NodeWebSocket(url, { handshakeTimeout: 10_000 });
    sockets.push(socket);
    await once(socket, "open");
    return {
      socket,
      api: newWebSocketRpcSession<{
        getState(): { instance: string; value: number };
        increment(): { instance: string; value: number };
      }>(socket as unknown as WebSocket),
    };
  }
  try {
    const first = await connect();
    using firstApi = first.api;
    const initial = await firstApi.increment();
    expect(initial).toMatchObject({ value: 1 });

    for (let attempt = 0; attempt < 2; attempt++) {
      const next = await connect();
      using nextApi = next.api;
      expect(await nextApi.getState()).toEqual(initial);
      expect(first.socket, "an existing connection must stay open").toMatchObject({
        readyState: NodeWebSocket.OPEN,
      });
      expect(await firstApi.getState()).toEqual(initial);
      const closed = once(next.socket, "close");
      nextApi[Symbol.dispose]();
      await closed;
    }
    const firstClosed = once(first.socket, "close");
    await project.repo.commitFiles({
      message: "Update app code while preserving the SQLite worker identity",
      changes: [{ path: "app.ts", content: appSource.replace('version: "one"', 'version: "two"') }],
    });
    expect(await worker.getState()).toMatchObject({ version: "two", value: 1 });
    await firstClosed;
    firstApi[Symbol.dispose]();
    // Reproduce a returning browser after all application sockets have closed.
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    const reopened = await connect();
    using reopenedApi = reopened.api;
    expect(await reopenedApi.getState()).toMatchObject({ version: "two", value: 1 });
    expect(await worker.getState()).toMatchObject({ version: "two", value: 1 });
  } finally {
    for (const socket of sockets) socket.terminate();
  }
});
