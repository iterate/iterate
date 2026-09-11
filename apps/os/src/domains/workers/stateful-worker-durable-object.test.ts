import { beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { StatefulDynamicWorkerRef } from "./schemas.ts";
import { StatefulWorkerDurableObject } from "./stateful-worker-durable-object.ts";
import { withWorkerFetchDispatchHeader } from "./worker-fetch-dispatch.ts";
import { WORKER_SERVE_HEADER } from "./worker-serve-info.ts";

const h = vi.hoisted(() => ({
  loadResolvedWorker: vi.fn(),
  resolveWorkerSource: vi.fn(),
}));

vi.mock("../../env.ts", () => ({ itxEnv: {} }));
vi.mock("../itx/utils.ts", () => ({
  itxEntrypointBinding: () => ({}),
  itxEntrypointProps: (input: unknown) => input,
}));
vi.mock("../projects/utils.ts", () => ({ projectEgressFetcher: () => ({}) }));
vi.mock("./worker-loader.ts", () => ({
  ...h,
  isWorkerBuildInProgressError: () => false,
}));

const ref = {
  type: "stateful",
  path: "/",
  className: "Notes",
  durableWorkerKey: "notes",
  source: {
    createWorker: { files: { type: "repo", repoPath: "/repos/config" } },
  },
} satisfies StatefulDynamicWorkerRef;

function host() {
  const storage = new Map<string, unknown>();
  const running = new Map<string, object>();
  const target = {
    fetch: vi.fn(async () => new Response("notes")),
    invokeCapability: vi.fn(),
    listNotes: vi.fn(async () => ["saved note"]),
  };
  const start = vi.fn();
  const abort = vi.fn((name: string) => running.delete(name));
  const ctx = {
    exports: {},
    id: {
      name: DurableObjectNameCodec.stringify({
        projectId: "prj_reconnect",
        path: ref.path,
        props: { durableWorkerKey: ref.durableWorkerKey },
      }),
    },
    storage: { kv: { get: (key: string) => storage.get(key), put: storage.set.bind(storage) } },
    facets: {
      abort,
      get(name: string, startup: () => { class: object }) {
        // The runtime invokes startup only when this facet needs a class.
        // A warm facet ignores the new callback and keeps its existing class.
        return Object.fromEntries(
          Object.entries(target).map(([method, invoke]) => [
            method,
            async () => {
              if (!running.has(name)) {
                const options = startup();
                start(options);
                running.set(name, options.class);
              }
              return await invoke();
            },
          ]),
        );
      },
    },
  } as unknown as DurableObjectState;
  const object = new StatefulWorkerDurableObject(ctx, {} as Env);
  return {
    abort,
    object,
    running,
    start,
    target,
    fetch: () =>
      object.fetch(
        withWorkerFetchDispatchHeader(new Request("https://notes.example/api"), { ref }),
      ),
  };
}

beforeEach(() => {
  h.loadResolvedWorker.mockReset().mockImplementation(() => ({
    getDurableObjectClass: () => ({}),
  }));
  h.resolveWorkerSource.mockReset().mockResolvedValue({
    ok: true,
    source: { cacheKey: "build-one", commitOid: "a".repeat(40) },
  });
});

it("propagates a startup failure without retrying it through the user request", async () => {
  const app = host();
  const failure = new Error("worker class failed to load");
  h.loadResolvedWorker.mockImplementation(() => {
    throw failure;
  });

  await expect(app.fetch()).rejects.toBe(failure);
  expect(h.loadResolvedWorker).toHaveBeenCalledTimes(1);
  expect(app.target.fetch).not.toHaveBeenCalled();
});

it("reuses a warm facet without loading another worker for HTTP or RPC requests", async () => {
  const app = host();
  await app.fetch();
  expect(h.loadResolvedWorker).toHaveBeenCalledTimes(1);

  await app.fetch();
  await expect(
    app.object.invokeCapability({ ref, path: ["listNotes"], buildFailureNonce: "failure" }),
  ).resolves.toEqual(["saved note"]);

  expect(h.resolveWorkerSource).toHaveBeenCalledTimes(3);
  expect(h.loadResolvedWorker).toHaveBeenCalledTimes(1);
  expect(app.start).toHaveBeenCalledTimes(1);
  expect(app.abort).not.toHaveBeenCalled();
});

it("restarts changed source and loads a cold facet from the resolved build", async () => {
  const app = host();
  await app.fetch();
  h.resolveWorkerSource.mockResolvedValue({
    ok: true,
    source: { cacheKey: "build-two", commitOid: "b".repeat(40) },
  });

  const response = await app.fetch();
  expect(response.headers.get(WORKER_SERVE_HEADER)).toBe("b".repeat(40));
  expect(app.abort).toHaveBeenCalledTimes(1);
  expect(app.start).toHaveBeenCalledTimes(2);
  expect(h.loadResolvedWorker).toHaveBeenLastCalledWith(
    expect.objectContaining({ resolved: expect.objectContaining({ cacheKey: "build-two" }) }),
  );

  app.running.clear(); // A hibernated facet needs its startup callback again.
  await app.fetch();
  expect(app.start).toHaveBeenCalledTimes(3);
  expect(h.loadResolvedWorker).toHaveBeenCalledTimes(3);
  expect(app.abort).toHaveBeenCalledTimes(1);
});
