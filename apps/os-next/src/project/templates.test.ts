import { beforeEach, expect, test, vi } from "vitest";
import { downloadPublicGithubTemplate } from "@iterate-com/shared/config-repo-template/github";
import { ProjectProcessor } from "./processor.ts";
import { ProjectContract } from "./contract.ts";

vi.mock("@iterate-com/shared/config-repo-template/github", () => ({
  downloadPublicGithubTemplate: vi.fn(),
}));
const reference = `github:example/config#${"a".repeat(40)}&path:starter`;
const worker = "export default {fetch() {return new Response('My project')}}";

beforeEach(() => vi.resetAllMocks());

function project(existing?: Record<string, string>) {
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
  return { repo, itx, append, order, files: () => files };
}

async function create(fixture: ReturnType<typeof project>, template?: string) {
  const processor = new ProjectProcessor((call) => Promise.resolve(call(fixture.itx as never)));
  const tasks: Promise<unknown>[] = [];
  processor.processEvent({
    state: {
      ...ProjectContract.initialState(),
      creation: {
        status: "requested",
        offset: 1,
        ...(template && { configRepoTemplate: template }),
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

test("omitting a template seeds the minimal project without an agent or lifecycle subscription", async () => {
  const fixture = project();
  await create(fixture);
  expect(fixture.files()?.["worker.ts"]).toContain("Homepage of project");
  expect(fixture.files()?.["agents.js"]).toBeUndefined();
  expect(downloadPublicGithubTemplate).not.toHaveBeenCalled();
  expect(fixture.itx.append).not.toHaveBeenCalled();
  expect(fixture.order.at(-1)).toBe("events.iterate.com/project/created");
});

test("copies the pinned subdirectory into a fresh root commit and subscribes before project/created", async () => {
  vi.mocked(downloadPublicGithubTemplate).mockResolvedValue([
    { path: "worker.ts", content: worker },
    {
      path: "iterate.json",
      content: JSON.stringify({ events: ["events.iterate.com/project/created"] }),
    },
    { path: "custom.txt", content: "owned by this project" },
  ]);
  const fixture = project();
  await create(fixture, reference);
  expect(downloadPublicGithubTemplate).toHaveBeenCalledWith({
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
  expect(fixture.order).toEqual([
    "subscription",
    "events.iterate.com/project/ingress-configured",
    "events.iterate.com/project/created",
  ]);
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
  expect(downloadPublicGithubTemplate).toHaveBeenCalledTimes(1);
  expect(fixture.repo.commitFiles).toHaveBeenCalledTimes(1);
});

test("a nonempty config repo keeps the project's edits even when a new template is requested", async () => {
  const fixture = project({ "worker.ts": "my edited worker" });
  await create(fixture, reference);
  expect(fixture.files()).toEqual({ "worker.ts": "my edited worker" });
  expect(downloadPublicGithubTemplate).not.toHaveBeenCalled();
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
  if (files) vi.mocked(downloadPublicGithubTemplate).mockResolvedValue(files);
  else vi.mocked(downloadPublicGithubTemplate).mockRejectedValue(new Error(error));
  const fixture = project();
  await create(fixture, reference);
  expect(fixture.repo.commitFiles).not.toHaveBeenCalled();
  expect(fixture.append).toHaveBeenCalledExactlyOnceWith({
    type: "events.iterate.com/project/create-failed",
    payload: { error: expect.stringContaining(error) },
  });
});
