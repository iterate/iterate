import { expect, test, vi } from "vitest";
import { PRESET } from "../../vitest.global-setup.ts";
import { templates } from "../generated/config-templates.js";
import { ProjectProcessor } from "./processor.ts";
import { ProjectContract, type ProjectState } from "./contract.ts";

const reference = `github:example/config#${"a".repeat(40)}&path:starter`;
const worker = "export default {fetch() {return new Response('My project')}}";
const manifest = '{"main":"worker.ts"}';

test("omitting a template seeds core/configs/minimal: a homepage, and no packages", async () => {
  const fixture = project();
  await deliver(fixture, requested());
  expect(fixture.files()?.["worker.ts"]).toContain("Homepage of project");
  const manifest = JSON.parse(fixture.files()!["package.json"]!);
  expect(manifest).toMatchObject({ private: true, type: "module", main: "worker.ts" });
  expect(manifest).not.toHaveProperty("dependencies");
  expect(fixture.order.at(-1)).toBe("events.iterate.com/project/created");
  // an unborn `main` is its own check (`parent: null`): no read of the tip comes first
  expect(fixture.repo.tip).not.toHaveBeenCalled();
});

test("a preset the build was given is seeded from the build: nothing is downloaded", async () => {
  expect(templates).toContainEqual({ label: "Starter", reference: PRESET.reference });
  const fixture = project();
  await deliver(fixture, requested(PRESET.reference));
  expect(fixture.downloadTemplate).not.toHaveBeenCalled();
  expect(fixture.files()).toEqual(
    Object.fromEntries(PRESET.files.map((file) => [file.path, file.content])),
  );
});

test("copies the pinned subdirectory into a fresh root commit before project/created", async () => {
  const fixture = project(undefined, async () => [
    { path: "package.json", content: manifest },
    { path: "worker.ts", content: worker },
    { path: "custom.txt", content: "owned by this project" },
  ]);
  await deliver(fixture, requested(reference));
  expect(fixture.downloadTemplate).toHaveBeenCalledWith({
    owner: "example",
    repo: "config",
    ref: "a".repeat(40),
    path: "starter",
  });
  expect(fixture.files()).toEqual({
    "package.json": manifest,
    "worker.ts": worker,
    "custom.txt": "owned by this project",
  });
  expect(fixture).toMatchObject({
    order: ["events.iterate.com/itx/ingress-configured", "events.iterate.com/project/created"],
  });
  expect(fixture.repo.commitFiles).toHaveBeenCalledTimes(1);
  // Recovery after a successful commit lost its acknowledgement must preserve the tree: the born
  // `main` refuses the second seed, and its tip is the project's config.
  const seeded = fixture.files();
  await deliver(fixture, requested(reference));
  expect(fixture.repo.commitFiles).toHaveBeenCalledTimes(2);
  await expect(fixture.repo.commitFiles.mock.results[1]!.value).rejects.toThrow(/refused/);
  expect(fixture.files()).toBe(seeded);
  expect(fixture.order.at(-1)).toBe("events.iterate.com/project/created");
});

test("a template's pkg.pr.new branch is seeded at the commit pkg.pr.new serves, one HEAD per version; devDependencies and other manifests keep their bytes", async () => {
  const commit = "d".repeat(40);
  const voiceMain = "https://pkg.pr.new/iterate/iterate/@iterate-com/voice@main";
  const head = vi.fn(
    async () => new Response(null, { headers: { "x-commit-key": `iterate:iterate:${commit}` } }),
  );
  vi.stubGlobal("fetch", head);
  const manifestOf = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const root = manifestOf({
    main: "worker.ts",
    dependencies: { "@iterate-com/voice": voiceMain, hono: "^4" },
    devDependencies: { iterate: "https://pkg.pr.new/iterate/iterate/iterate@main" },
  });
  const agents = manifestOf({
    main: "index.ts",
    dependencies: { "@iterate-com/voice": voiceMain },
  });
  const fixture = project(undefined, async () => [
    { path: "package.json", content: root },
    { path: "worker.ts", content: worker },
    { path: "agents/package.json", content: agents },
    { path: "agents/index.ts", content: "export {};" },
    { path: "fixtures/package.json", content: '{"name":"fixture"}' },
  ]);
  await deliver(fixture, requested(reference));
  const pinned = `https://pkg.pr.new/iterate/iterate/@iterate-com/voice@${commit}`;
  expect(fixture.files()).toMatchObject({
    "package.json": root.replace(voiceMain, pinned),
    "agents/package.json": agents.replace(voiceMain, pinned),
    "fixtures/package.json": '{"name":"fixture"}',
  });
  expect(head).toHaveBeenCalledExactlyOnceWith(
    voiceMain,
    expect.objectContaining({ method: "HEAD" }),
  );
  expect(fixture.order.at(-1)).toBe("events.iterate.com/project/created");
});

test("a template's pkg.pr.new branch that pkg.pr.new cannot pin fails the creation, and nothing is seeded", async () => {
  const missing = "https://pkg.pr.new/iterate/iterate/@iterate-com/voice@no-such-branch";
  // pkg.pr.new's 404 echoes the ref it was asked for
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(null, {
        status: 404,
        headers: { "x-commit-key": "iterate:iterate:no-such-branch" },
      }),
  );
  const fixture = project(undefined, async () => [
    {
      path: "package.json",
      content: JSON.stringify({
        main: "worker.ts",
        dependencies: { "@iterate-com/voice": missing },
      }),
    },
    { path: "worker.ts", content: worker },
  ]);
  await deliver(fixture, requested(reference));
  expect(fixture.repo.commitFiles).not.toHaveBeenCalled();
  expect(fixture.append).toHaveBeenCalledExactlyOnceWith({
    type: "events.iterate.com/project/create-failed",
    payload: {
      error: `${missing} answered 404 without naming the commit it serves, so it cannot be pinned`,
    },
  });
});

test("a nonempty config repo keeps the project's edits even when a new template is requested", async () => {
  const fixture = project({ "worker.ts": "my edited worker" }, async () => [
    { path: "package.json", content: manifest },
    { path: "worker.ts", content: worker },
  ]);
  await deliver(fixture, requested(reference));
  expect(fixture.files()).toEqual({ "worker.ts": "my edited worker" });
  await expect(fixture.repo.commitFiles.mock.results[0]!.value).rejects.toThrow(/refused/);
  expect(fixture.order.at(-1)).toBe("events.iterate.com/project/created");
});

test("a template that cannot be downloaded is no failure when main is born: its tip is the project's config", async () => {
  const fixture = project({ "worker.ts": "my edited worker" }, async () => {
    throw new Error("GitHub unavailable");
  });
  await deliver(fixture, requested(reference));
  expect(fixture.repo.commitFiles).not.toHaveBeenCalled();
  expect(fixture.files()).toEqual({ "worker.ts": "my edited worker" });
  expect(fixture.order.at(-1)).toBe("events.iterate.com/project/created");
});

test.for([
  { name: "source unavailable", files: null, error: "GitHub unavailable" },
  {
    name: "missing entrypoint",
    files: [{ path: "README.md", content: "not a config" }],
    error: 'The config template: no entry — name the entry module in package.json "main"',
  },
  {
    name: "a main that is not a file",
    files: [{ path: "package.json", content: '{"main":"src/worker.ts"}' }],
    error: `The config template: no entry — package.json's main "src/worker.ts" is not a file`,
  },
])("$name is one durable failure without activation or success", async ({ files, error }) => {
  const fixture = project(undefined, async () => {
    if (files) return files;
    throw new Error(error);
  });
  await deliver(fixture, requested(reference));
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
  await deliver(fixture, requested());
  expect(fixture.repo.commitFiles).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ parent: null }),
  );
  expect(fixture.files()).toEqual({ "worker.ts": "the agent's edit" });
  expect(fixture).toMatchObject({
    order: ["events.iterate.com/itx/ingress-configured", "events.iterate.com/project/created"],
  });
  // the hosts answer from whatever the follower publishes, the outside commit first
  expect(fixture.append).toHaveBeenCalledWith({
    type: "events.iterate.com/itx/ingress-configured",
    idempotencyKey: "itx/ingress-configured",
    payload: { target: ["itx", "config"] },
  });
});

test.for([
  { name: "the seed's publication", fact: 4 },
  { name: "its refusal or the platform's give-up", fact: 5 },
])(
  "the saga seeds and returns: nothing lands while the seed's commit waits for its publication, and $name lands the ingress, then the certificate",
  async ({ fact }) => {
    const fixture = project();
    await deliver(fixture, requested(), { publishes: true });
    expect(fixture.repo.commitFiles).toHaveBeenCalledOnce();
    expect(fixture).toMatchObject({ order: [] });
    const seeded = { ...requested(), configRepoTip: { commitOid: "b".repeat(40), offset: 3 } };
    await deliver(fixture, seeded, { publishes: true });
    expect(fixture).toMatchObject({ order: [] });
    await deliver(fixture, { ...seeded, lastPublicationFactOffset: fact }, { publishes: true });
    expect(fixture.repo.commitFiles).toHaveBeenCalledOnce();
    expect(fixture).toMatchObject({
      order: ["events.iterate.com/itx/ingress-configured", "events.iterate.com/project/created"],
    });
  },
);

test("a seed that fails and leaves main unborn is one durable failure", async () => {
  const fixture = project();
  fixture.repo.commitFiles.mockRejectedValueOnce(new Error("Artifacts answered 500"));
  await deliver(fixture, requested());
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
  };
  const commitFromOutside = (changed: Record<string, string>) => {
    files = { ...files, ...changed };
    tipOid = "c".repeat(40);
  };
  const itx = {
    repos: { create: vi.fn(async () => {}), get: () => repo },
    [Symbol.dispose]: () => {},
  };
  const append = vi.fn(async (...events: { type: string }[]) => {
    order.push(...events.map((event) => event.type));
  });
  const downloadTemplate = vi.fn(download);
  return { repo, itx, append, order, downloadTemplate, commitFromOutside, files: () => files };
}

/** The project's creation requested, of `template` when given. */
function requested(template?: string): ProjectState {
  const creation = { status: "requested" as const, offset: 1, configRepoTemplate: template };
  return { ...ProjectContract.initialState(), creation };
}

/** One delivery of `state` at head; a processor that `publishes` finds `main` unborn and lands what
 *  it appends nowhere, so these rows read the saga's own appends alone. */
async function deliver(
  fixture: ReturnType<typeof project>,
  state: ProjectState,
  { publishes = false } = {},
) {
  const unread = () => Promise.reject(new Error("an unborn main has no files"));
  const publisher = {
    head: async () => null,
    files: unread,
    identityOf: unread,
    probe: unread,
    appendAsPlatform: async () => [],
  };
  const processor = new ProjectProcessor(
    () => fixture.itx as never,
    fixture.downloadTemplate,
    () => null,
    () => null,
    () => (publishes ? publisher : null),
  );
  const tasks: Promise<unknown>[] = [];
  processor.processEvent({
    state,
    previousState: state,
    delivery: { caughtUp: true },
    append: fixture.append,
    runInBackground: (run: () => Promise<unknown>) => {
      tasks.push(run());
    },
  } as never);
  await Promise.all(tasks);
}
