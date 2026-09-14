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
  // workerd keeps a facet whose startup callback threw in the parent's facet
  // map with its rejected start promise: every later call under that name
  // replays the failure until ctx.facets.abort erases the entry.
  const failed = new Map<string, unknown>();
  const target = {
    fetch: vi.fn(async () => new Response("notes")),
    invokeCapability: vi.fn(),
    listNotes: vi.fn(async () => ["saved note"]),
  };
  const start = vi.fn();
  const abort = vi.fn((name: string) => {
    running.delete(name);
    failed.delete(name);
  });
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
              if (failed.has(name)) throw failed.get(name);
              if (!running.has(name)) {
                try {
                  const options = startup();
                  start(options);
                  running.set(name, options.class);
                } catch (error) {
                  failed.set(name, error);
                  throw error;
                }
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

it("aborts a facet whose startup callback threw so the next request restarts it", async () => {
  const app = host();
  const outage = new Error("loader unavailable");
  h.loadResolvedWorker.mockImplementationOnce(() => {
    throw outage;
  });

  await expect(app.fetch()).rejects.toBe(outage);
  expect(app.abort).toHaveBeenCalledWith("target", "facet startup failed");

  // The loader is healthy again: the aborted facet starts afresh and loads
  // its class a second time instead of replaying the rejected startup.
  await expect(app.fetch()).resolves.toBeInstanceOf(Response);
  expect(h.loadResolvedWorker).toHaveBeenCalledTimes(2);
  expect(app.start).toHaveBeenCalledTimes(1);
  expect(app.target.fetch).toHaveBeenCalledTimes(1);
});

it("replays the startup failure on every later request when the abort does not land", async () => {
  // The negative control for the fake's workerd semantics: without the abort
  // the broken facet answers every request with the same rejection and never
  // asks for a class again — the wedge this abort exists to clear.
  const app = host();
  const outage = new Error("loader unavailable");
  h.loadResolvedWorker.mockImplementationOnce(() => {
    throw outage;
  });
  app.abort.mockImplementationOnce(() => {});

  await expect(app.fetch()).rejects.toBe(outage);
  await expect(app.fetch()).rejects.toBe(outage);
  expect(app.abort).toHaveBeenCalledTimes(1);
  expect(h.loadResolvedWorker).toHaveBeenCalledTimes(1);
  expect(app.start).not.toHaveBeenCalled();
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
