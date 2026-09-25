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
  // The seed is committed at once: an unborn `main` is its own check (`parent: null`), so no read of
  // the tip comes first, and the manifest is read from the commit just pushed.
  expect(fixture.repo.tip).not.toHaveBeenCalled();
  expect(fixture.repo.readFile).toHaveBeenCalledExactlyOnceWith("iterate.json", {
    commitOid: "b".repeat(40),
  });
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
      "events.iterate.com/itx/ingress-configured",
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
  // Recovery after a successful commit lost its acknowledgement must preserve the tree: the born
  // `main` refuses the second seed, and its tip is the project's config.
  const seeded = fixture.files();
  await create(fixture, reference);
  expect(fixture.repo.commitFiles).toHaveBeenCalledTimes(2);
  await expect(fixture.repo.commitFiles.mock.results[1]!.value).rejects.toThrow(/refused/);
  expect(fixture.files()).toBe(seeded);
  expect(fixture.order.at(-1)).toBe("events.iterate.com/project/created");
});

test("a nonempty config repo keeps the project's edits even when a new template is requested", async () => {
  const fixture = project({ "worker.ts": "my edited worker" }, async () => [
    { path: "worker.ts", content: worker },
  ]);
  await create(fixture, reference);
  expect(fixture.files()).toEqual({ "worker.ts": "my edited worker" });
  await expect(fixture.repo.commitFiles.mock.results[0]!.value).rejects.toThrow(/refused/);
  expect(fixture.order.at(-1)).toBe("events.iterate.com/project/created");
});

test("a template that cannot be downloaded is no failure when main is born: its tip is the project's config", async () => {
  const fixture = project({ "worker.ts": "my edited worker" }, async () => {
    throw new Error("GitHub unavailable");
  });
  await create(fixture, reference);
  expect(fixture.repo.commitFiles).not.toHaveBeenCalled();
  expect(fixture.files()).toEqual({ "worker.ts": "my edited worker" });
  expect(fixture.order.at(-1)).toBe("events.iterate.com/project/created");
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

test("a commit that lands before the seed is the project's config: the seed is refused, never pushed on top of it", async () => {
  const fixture = project();
  // The project's caller writes its config repo before the seed lands (`create` answers before the
  // certificate) — the voice delegation's website edit, 2026-09-24.
  const seed = fixture.repo.commitFiles.getMockImplementation()!;
  fixture.repo.commitFiles.mockImplementationOnce(async (input) => {
    fixture.commitFromOutside({ "worker.ts": "the agent's edit" });
    return seed(input);
  });
  await create(fixture);
  expect(fixture.repo.commitFiles).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ parent: null }),
  );
  expect(fixture.files()).toEqual({ "worker.ts": "the agent's edit" });
  expect(fixture).toMatchObject({
    order: ["events.iterate.com/itx/ingress-configured", "events.iterate.com/project/created"],
  });
  expect(fixture.append).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: {
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
                ["modules", { commitOid: "c".repeat(40) }],
              ],
              cacheKey: "c".repeat(40),
            },
          ],
        ],
      },
    }),
    expect.objectContaining({ type: "events.iterate.com/project/created" }),
  );
});

test("a seed that fails and leaves main unborn is one durable failure", async () => {
  const fixture = project();
  fixture.repo.commitFiles.mockRejectedValueOnce(new Error("Artifacts answered 500"));
  await create(fixture);
  expect(fixture.files()).toBeUndefined();
  expect(fixture.append).toHaveBeenCalledExactlyOnceWith({
    type: "events.iterate.com/project/create-failed",
    payload: { error: "Artifacts answered 500" },
  });
});

/** A project whose config repo holds `existing` (none: `main` is unborn), with a fake template
 *  download answering `download`. A commit through the facet lands `b…`; `commitFromOutside` lands
 *  `c…`, as another caller's would. */
function project(
  existing?: Record<string, string>,
  download: () => Promise<Array<{ path: string; content: string }>> = async () => {
    throw new Error("no template was expected");
  },
) {
  let files = existing;
  let tipOid = "b".repeat(40);
  const order: string[] = [];
  const repo = {
    tip: vi.fn(async (): Promise<string | null> => (files ? tipOid : null)),
    commitFiles: vi.fn(
      async (input: { changes: { path: string; content: string }[]; parent?: string | null }) => {
        const tip = files ? tipOid : null;
        if ("parent" in input && input.parent !== tip)
          throw new Error(`the commit was refused: main is at ${tip}, not at ${input.parent}`);
        const { changes } = input;
        files = Object.fromEntries(changes.map((file) => [file.path, file.content]));
        tipOid = "b".repeat(40);
        return { commitOid: tipOid };
      },
    ),
    readFile: vi.fn(async (path: string) => files?.[path] ?? null),
  };
  const commitFromOutside = (changed: Record<string, string>) => {
    files = { ...files, ...changed };
    tipOid = "c".repeat(40);
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
  return { repo, itx, append, order, downloadTemplate, commitFromOutside, files: () => files };
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
    previousState: ProjectContract.initialState(),
    delivery: { caughtUp: true },
    append: fixture.append,
    runInBackground: (run: () => Promise<unknown>) => {
      tasks.push(run());
    },
  } as never);
  await Promise.all(tasks);
}
