import { expect, test, vi } from "vitest";
import { ProjectProcessor } from "./processor.ts";
import { ProjectContract } from "./contract.ts";

const reference = `github:example/config#${"a".repeat(40)}&path:starter`;
const worker = "export default {fetch() {return new Response('My project')}}";

test("omitting a template seeds the minimal project without an agent or lifecycle subscription", async () => {
  const fixture = project();
  await create(fixture);
  expect(fixture.files()?.["worker.ts"]).toContain("Homepage of project");
  expect(fixture.files()?.["agents.js"]).toBeUndefined();
  expect(fixture.downloadTemplate).not.toHaveBeenCalled();
  expect(fixture.itx.append).not.toHaveBeenCalled();
  expect(fixture.order.at(-1)).toBe("events.iterate.com/project/created");
});

test("copies the pinned subdirectory into a fresh root commit and subscribes before project/created", async () => {
  const fixture = project(undefined, async () => [
    { path: "worker.ts", content: worker },
    {
      path: "iterate.json",
      content: JSON.stringify({ events: ["events.iterate.com/project/created"] }),
    },
    { path: "custom.txt", content: "owned by this project" },
  ]);
  await create(fixture, reference);
  expect(fixture.downloadTemplate).toHaveBeenCalledWith({
    owner: "example",
    repo: "config",
    ref: "a".repeat(40),
    path: "starter",
  });
  expect(fixture.files()).toEqual({
    "worker.ts": worker,
    "iterate.json": JSON.stringify({ events: ["events.iterate.com/project/created"] }),
    "custom.txt": "owned by this project",
  });
  expect(fixture).toMatchObject({
    order: [
      "subscription",
      "events.iterate.com/project/ingress-configured",
      "events.iterate.com/project/created",
    ],
  });
  expect(fixture.itx.append).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        target: [
          "itx",
          "workers",
          [
            "get",
            {
              source: [
                "itx",
                "repos",
                ["get", "/repos/config"],
                ["modules", { commitOid: "b".repeat(40) }],
              ],
              cacheKey: "b".repeat(40),
            },
          ],
          "processEventBatch",
        ],
      }),
    }),
  );
  expect(fixture.repo.commitFiles).toHaveBeenCalledTimes(1);
  // Recovery after a successful commit lost its acknowledgement must preserve the tree.
  await create(fixture, reference);
  expect(fixture.downloadTemplate).toHaveBeenCalledTimes(1);
  expect(fixture.repo.commitFiles).toHaveBeenCalledTimes(1);
});

test("a nonempty config repo keeps the project's edits even when a new template is requested", async () => {
  const fixture = project({ "worker.ts": "my edited worker" });
  await create(fixture, reference);
  expect(fixture.files()).toEqual({ "worker.ts": "my edited worker" });
  expect(fixture.downloadTemplate).not.toHaveBeenCalled();
  expect(fixture.repo.commitFiles).not.toHaveBeenCalled();
});

test.for([
  { name: "source unavailable", files: null, error: "GitHub unavailable" },
  {
    name: "missing entrypoint",
    files: [{ path: "README.md", content: "not a config" }],
    error: "worker.ts entrypoint",
  },
])("$name is one durable failure without activation or success", async ({ files, error }) => {
  const fixture = project(undefined, async () => {
    if (files) return files;
    throw new Error(error);
  });
  await create(fixture, reference);
  expect(fixture.repo.commitFiles).not.toHaveBeenCalled();
  expect(fixture.append).toHaveBeenCalledExactlyOnceWith({
    type: "events.iterate.com/project/create-failed",
    payload: { error: expect.stringContaining(error) },
  });
});

/** A project whose config repo holds `existing` (none: `main` is unborn), with a fake template
 *  download answering `download`. */
function project(
  existing?: Record<string, string>,
  download: () => Promise<Array<{ path: string; content: string }>> = async () => {
    throw new Error("no template was expected");
  },
) {
  let files = existing;
  const order: string[] = [];
  const repo = {
    tip: vi.fn(async () => (files ? "b".repeat(40) : null)),
    commitFiles: vi.fn(async ({ changes }: { changes: { path: string; content: string }[] }) => {
      files = Object.fromEntries(changes.map((file) => [file.path, file.content]));
      return { commitOid: "b".repeat(40) };
    }),
    readFile: vi.fn(async (path: string) => files?.[path] ?? null),
  };
  const itx = {
    repos: { create: vi.fn(async () => {}), get: () => repo },
    append: vi.fn(async () => {
      order.push("subscription");
    }),
  };
  const append = vi.fn(async (...events: { type: string }[]) => {
    order.push(...events.map((event) => event.type));
  });
  const downloadTemplate = vi.fn(download);
  return { repo, itx, append, order, downloadTemplate, files: () => files };
}

async function create(fixture: ReturnType<typeof project>, template?: string) {
  const processor = new ProjectProcessor(
    (call) => Promise.resolve(call(fixture.itx as never)),
    fixture.downloadTemplate,
  );
  const tasks: Promise<unknown>[] = [];
  processor.processEvent({
    state: {
      ...ProjectContract.initialState(),
      creation: {
        status: "requested",
        offset: 1,
        configRepoTemplate: template,
      },
    },
    delivery: { caughtUp: true },
    append: fixture.append,
    runInBackground: (run: () => Promise<unknown>) => {
      tasks.push(run());
    },
  } as never);
  await Promise.all(tasks);
}
