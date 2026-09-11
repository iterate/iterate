import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { newWebSocketRpcSession, RpcTarget } from "@iterate-com/capnweb";
import { WebSocketServer } from "ws";
import { connectItxReady } from "./itx-node-client.ts";

test("disposing an awaited project closes its owning RPC session", async () => {
  await using server = await rpcServer();
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  using project = await connectItxReady({
    baseUrl: server.baseUrl,
    auth: { type: "admin-secret", secret: "test" },
    projectId: "test-project",
    onWebSocketClose: closed.resolve,
  });
  expect(await project.__describe()).toMatchObject({ projectId: "test-project" });

  project[Symbol.dispose]();
  expect(await closed.promise).toMatchObject({ code: 3000 });
});

test("failed authentication closes the socket without retrying an RPC call", async () => {
  await using server = await rpcServer();
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  const retries: unknown[] = [];
  await expect(
    connectItxReady(
      {
        baseUrl: server.baseUrl,
        auth: { type: "admin-secret", secret: "wrong" },
        projectId: "test-project",
        onWebSocketClose: closed.resolve,
      },
      {
        retryInitialConnection: {
          onRetry: (retry) => {
            retries.push(retry);
          },
        },
      },
    ),
  ).rejects.toThrow("Invalid test secret");
  expect(await closed.promise).toMatchObject({ code: 3000 });
  expect(retries).toEqual([]);
});

async function rpcServer() {
  const http = createServer();
  const sockets = new WebSocketServer({ server: http });
  sockets.on("connection", (socket) => {
    newWebSocketRpcSession(socket as any, new Root());
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const { port } = http.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets.clients) socket.terminate();
      await Promise.all([
        new Promise<void>((resolve) => sockets.close(() => resolve())),
        new Promise<void>((resolve) => http.close(() => resolve())),
      ]);
    },
  };
}

class Root extends RpcTarget {
  authenticate(auth: { secret: string }) {
    if (auth.secret !== "test") throw new Error("Invalid test secret");
    return new Session();
  }
}

class Session extends RpcTarget {
  get projects() {
    return new Projects();
  }
}

class Projects extends RpcTarget {
  get(projectId: string) {
    return new Project(projectId);
  }
}

class Project extends RpcTarget {
  projectId: string;

  constructor(projectId: string) {
    super();
    this.projectId = projectId;
  }

  __describe() {
    return { projectId: this.projectId };
  }
}
