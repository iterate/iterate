import { expect, test } from "vitest";
import { TasksApp } from "./config-bridge.ts";

test("a configured Tasks app applies its project-member gate before proxying", async () => {
  const denied = new Response("sign in", { status: 401 });
  let receivedPolicy: unknown;
  let receivedRequest: Request | undefined;
  let disposed = false;
  const app = TasksApp.create(
    {
      ITX: {
        async get() {
          return {
            [Symbol.dispose]() {
              disposed = true;
            },
            auth: {
              get(policy: unknown) {
                receivedPolicy = policy;
                return {
                  async fetch(request: Request) {
                    receivedRequest = request;
                    return denied;
                  },
                };
              },
            },
            kv: {
              async get() {
                throw new Error("a denied request must not inspect the proxy override");
              },
            },
          };
        },
      },
    } as any,
    {
      auth: { policy: "project-member" },
      proxy: {
        origin: "https://tasks.iterate.workers.dev",
        originOverrideKvKey: "tasks-app-origin",
      },
    },
  );
  const request = new Request("https://tasks--demo.iterate.app/private");

  await expect(app.fetch(request)).resolves.toBe(denied);

  expect(receivedPolicy).toEqual({ policy: "project-member" });
  expect(receivedRequest).toBe(request);
  expect(disposed).toBe(true);
});

test("a project member's request is transparently proxied to the configured origin", async () => {
  const originalFetch = globalThis.fetch;
  using _restoreFetch = {
    [Symbol.dispose]() {
      globalThis.fetch = originalFetch;
    },
  };
  let proxiedRequest: Request | undefined;
  const upstreamResponse = new Response("tasks");
  globalThis.fetch = async (request) => {
    proxiedRequest = request instanceof Request ? request : new Request(request);
    return upstreamResponse;
  };
  let overrideKey: string | undefined;
  let disposed = false;
  const app = TasksApp.create(
    {
      ITX: {
        async get() {
          return {
            [Symbol.dispose]() {
              disposed = true;
            },
            auth: {
              get() {
                return { async fetch() {} };
              },
            },
            kv: {
              async get(key: string) {
                overrideKey = key;
                return null;
              },
            },
          };
        },
      },
    } as any,
    {
      auth: { policy: "project-member" },
      proxy: {
        origin: "https://tasks.iterate.workers.dev",
        originOverrideKvKey: "tasks-app-origin",
      },
    },
  );
  const request = new Request("https://tasks--demo.iterate.app/c/checkout?repo=config", {
    body: "hello",
    headers: {
      cookie: "iterate-project-auth=token",
      upgrade: "websocket",
      "x-itx-project-id": "prj_demo",
      "x-test": "preserved",
    },
    method: "POST",
  });

  await expect(app.fetch(request)).resolves.toBe(upstreamResponse);

  expect(overrideKey).toBe("tasks-app-origin");
  expect(proxiedRequest).toMatchObject({
    method: "POST",
    redirect: "manual",
    url: "https://tasks.iterate.workers.dev/c/checkout?repo=config",
  });
  expect(proxiedRequest?.headers.get("cookie")).toBe("iterate-project-auth=token");
  expect(proxiedRequest?.headers.get("upgrade")).toBe("websocket");
  expect(proxiedRequest?.headers.get("x-itx-project-id")).toBe("prj_demo");
  expect(proxiedRequest?.headers.get("x-test")).toBe("preserved");
  expect(await proxiedRequest?.text()).toBe("hello");
  expect(disposed).toBe(true);
});

test("the configured proxy target must be one complete HTTPS origin", () => {
  for (const origin of [
    "tasks.iterate.workers.dev",
    "http://tasks.iterate.workers.dev",
    "https://tasks.iterate.workers.dev/nested",
  ]) {
    expect(() =>
      TasksApp.create({} as any, {
        auth: { policy: "project-member" },
        proxy: { origin, originOverrideKvKey: "tasks-app-origin" },
      }),
    ).toThrowError(`Tasks app proxy origin must be one complete HTTPS origin: ${origin}`);
  }
});

test("a full HTTPS origin in project KV overrides the configured target", async () => {
  const originalFetch = globalThis.fetch;
  using _restoreFetch = {
    [Symbol.dispose]() {
      globalThis.fetch = originalFetch;
    },
  };
  let proxiedRequest: Request | undefined;
  globalThis.fetch = async (request) => {
    proxiedRequest = request instanceof Request ? request : new Request(request);
    return new Response("local tasks");
  };
  const app = TasksApp.create(
    {
      ITX: {
        async get() {
          return {
            [Symbol.dispose]() {},
            auth: {
              get() {
                return { async fetch() {} };
              },
            },
            kv: {
              async get() {
                return "https://misha-tasks.tunnels.iterate.com";
              },
            },
          };
        },
      },
    } as any,
    {
      auth: { policy: "project-member" },
      proxy: {
        origin: "https://tasks.iterate.workers.dev",
        originOverrideKvKey: "tasks-app-origin",
      },
    },
  );

  await app.fetch(new Request("https://tasks--demo.iterate.app/c/checkout?repo=config"));

  expect(proxiedRequest).toMatchObject({
    url: "https://misha-tasks.tunnels.iterate.com/c/checkout?repo=config",
  });
});

test("a malformed KV override fails instead of sending project traffic to it", async () => {
  const app = TasksApp.create(
    {
      ITX: {
        async get() {
          return {
            [Symbol.dispose]() {},
            auth: {
              get() {
                return { async fetch() {} };
              },
            },
            kv: {
              async get() {
                return "http://local-tasks.test";
              },
            },
          };
        },
      },
    } as any,
    {
      auth: { policy: "project-member" },
      proxy: {
        origin: "https://tasks.iterate.workers.dev",
        originOverrideKvKey: "tasks-app-origin",
      },
    },
  );

  await expect(app.fetch(new Request("https://tasks--demo.iterate.app/"))).rejects.toThrowError(
    'Tasks app proxy override from "tasks-app-origin" must be one complete HTTPS origin: http://local-tasks.test',
  );
});

test("builds an environment-correct board link for a workspace", async () => {
  let requestedSlug: string | undefined;
  let disposed = false;
  const app = TasksApp.create(
    {
      ITX: {
        async get() {
          return {
            [Symbol.dispose]() {
              disposed = true;
            },
            async appUrl(slug: string) {
              requestedSlug = slug;
              return "https://tasks--demo.iterate.app/";
            },
            auth: {
              get() {
                return { async fetch() {} };
              },
            },
            kv: {
              async get() {
                return null;
              },
            },
          };
        },
      },
    } as any,
    {
      auth: { policy: "project-member" },
      proxy: {
        origin: "https://tasks.iterate.workers.dev",
        originOverrideKvKey: "tasks-app-origin",
      },
    },
  );

  await expect(
    app.rpc.link({
      repo: "/repos/config",
      task: "tasks/plan.md",
      workspace: "/workspaces/agents/you",
    }),
  ).resolves.toBe(
    "https://tasks--demo.iterate.app/w?workspace=%2Fworkspaces%2Fagents%2Fyou&repo=%2Frepos%2Fconfig&task=tasks%2Fplan.md",
  );
  expect(requestedSlug).toBe("tasks");
  expect(disposed).toBe(true);

  await expect(
    app.rpc.link({ repo: "/repos/config", workspace: "/workspaces/agents/you" }),
  ).resolves.toBe(
    "https://tasks--demo.iterate.app/w?workspace=%2Fworkspaces%2Fagents%2Fyou&repo=%2Frepos%2Fconfig",
  );
});

test.each([
  { repo: "/repos/config", workspace: "/repos/config" },
  { repo: "/repos/config", workspace: "/workspaces/" },
  { repo: "/repos/config", workspace: "/workspaces/agents/../you" },
  { repo: "/repos", workspace: "/workspaces/agents/you" },
  { repo: "repos/config", workspace: "/workspaces/agents/you" },
  { repo: "/repos/config", task: "notes.md", workspace: "/workspaces/agents/you" },
  { repo: "/repos/config", task: "/repos/config/tasks/plan.md", workspace: "/workspaces/agents/you" },
  { repo: "/repos/config", task: "tasks/plan.txt", workspace: "/workspaces/agents/you" },
])("refuses to mint a link the board would reject (%j)", async (input) => {
  const app = TasksApp.create(
    {
      ITX: {
        async get() {
          throw new Error("validation must fail before any platform call");
        },
      },
    } as any,
    {
      auth: { policy: "project-member" },
      proxy: {
        origin: "https://tasks.iterate.workers.dev",
        originOverrideKvKey: "tasks-app-origin",
      },
    },
  );
  await expect(app.rpc.link(input)).rejects.toThrow();
});

test("a non-string KV override fails instead of silently using the configured origin", async () => {
  const app = TasksApp.create(
    {
      ITX: {
        async get() {
          return {
            [Symbol.dispose]() {},
            auth: {
              get() {
                return { async fetch() {} };
              },
            },
            kv: {
              async get() {
                return { origin: "https://local-tasks.test" };
              },
            },
          };
        },
      },
    } as any,
    {
      auth: { policy: "project-member" },
      proxy: {
        origin: "https://tasks.iterate.workers.dev",
        originOverrideKvKey: "tasks-app-origin",
      },
    },
  );

  await expect(app.fetch(new Request("https://tasks--demo.iterate.app/"))).rejects.toThrowError(
    'Tasks app proxy override from "tasks-app-origin" must be one complete HTTPS origin: {"origin":"https://local-tasks.test"}',
  );
});
