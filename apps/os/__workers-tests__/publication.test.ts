// __workers-tests__/publication.test.ts — THE PUBLICATION's manifest and probe on the real loader
// (src/project/publication.ts): each top-level module's identity as `moduleIdentityOf` resolves it,
// and the probe, a generated entry that imports them all and constructs the config entrypoint,
// loaded as a worker of the project's root.
// The follower that publishes a commit with them is src/project/processor.test.ts's; the whole
// publication of a created project, e2e/website-publication.e2e.test.ts's.
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { moduleIdentityOf } from "../src/context/worker-loader.ts";
import { manifestOf, type ProjectPublisher } from "../src/project/publication.ts";
import { stub } from "./support.ts";

test("a commit's manifest names each top-level module by what the loader loads for it, which a change elsewhere leaves as it was, and the Durable Object classes a facet names", async () => {
  const first = await manifestOf("aaa", 1, publisherOf(commit(configEntrypoint(), agentsModule())));
  expect(first).toEqual({
    generation: 1,
    modules: {
      "agents.ts": { identity: expect.stringMatching(/^[0-9a-f]{64}$/), classes: ["Tally"] },
      "worker.ts": { identity: expect.stringMatching(/^[0-9a-f]{64}$/), classes: [] },
    },
  });
  // the website changes, the agents' module does not: its identity stays
  const edited = `${configEntrypoint()}\nexport const homepage = "new";`;
  const second = await manifestOf("bbb", 2, publisherOf(commit(edited, agentsModule())));
  expect(second.modules["agents.ts"]).toEqual(first.modules["agents.ts"]);
  expect(second.modules["worker.ts"]).not.toMatchObject({
    identity: first.modules["worker.ts"]!.identity,
  });
});

test.for([
  {
    name: "a main module whose default export is a plain entrypoint",
    files: commit(
      'import { WorkerEntrypoint } from "cloudflare:workers";\nexport default class extends WorkerEntrypoint {}',
      agentsModule(),
    ),
    error: /worker\.ts's default export is not an IterateConfigEntrypoint/,
  },
  {
    name: "a config entrypoint whose constructor throws",
    files: commit(
      `import { IterateConfigEntrypoint } from "iterate/sdk";
export default class extends IterateConfigEntrypoint {
  constructor(ctx, env) { super(ctx, env); throw new Error("no env var FOO"); }
}`,
      agentsModule(),
    ),
    error: /worker\.ts's default export does not construct: no env var FOO/,
  },
  {
    name: "a config entrypoint whose field initializer throws",
    files: commit(
      `import { IterateConfigEntrypoint } from "iterate/sdk";
export default class extends IterateConfigEntrypoint {
  settings = JSON.parse("not json");
}`,
      agentsModule(),
    ),
    error: /worker\.ts's default export does not construct/,
  },
  {
    name: "a module that does not resolve",
    files: commit(configEntrypoint(), `import "./missing.ts";\n${agentsModule()}`),
    error: /agents\.ts imports \.\/missing\.ts, and there is no such file/,
  },
])("a commit is refused: $name", async ({ files, error }) => {
  await expect(manifestOf("bbb", 2, publisherOf(files))).rejects.toThrow(error);
});

test("a first publication is refused when a side module does not resolve: every top-level module resolves", async () => {
  const files = { ...commit(configEntrypoint(), agentsModule()), "seed.ts": 'import "left-pad";' };
  await expect(manifestOf("aaa", 1, publisherOf(files))).rejects.toThrow(/left-pad/);
});

test("a side script that throws as it is imported is published: its identity stays in the manifest, exporting no class", async () => {
  const files = {
    ...commit(configEntrypoint(), agentsModule()),
    "seed.ts": 'throw new Error("run me with node, not as a module of the worker");',
  };
  const manifest = await manifestOf("aaa", 1, publisherOf(files));
  expect(manifest.modules["seed.ts"]).toEqual({
    identity: expect.stringMatching(/^[0-9a-f]{64}$/),
    classes: [],
  });
  expect(manifest.modules["agents.ts"]).toMatchObject({ classes: ["Tally"] });
});

/** A config commit of the default template's shape: a config entrypoint, and a module of classes. */
function commit(worker: string, agents: string) {
  return {
    "package.json": '{"main":"worker.ts"}',
    "worker.ts": worker,
    "agents.ts": agents,
    "AGENTS.md": "# not a module",
  };
}

function configEntrypoint() {
  return `import { IterateConfigEntrypoint } from "iterate/sdk";
export default class extends IterateConfigEntrypoint {}`;
}

function agentsModule() {
  return `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
export class Tally extends DurableObject {}
export class Api extends WorkerEntrypoint {}
export const version = 1;`;
}

/** The publisher durable-object.ts builds, over files in hand instead of the repo's. */
function publisherOf(files: Record<string, string>): ProjectPublisher {
  return {
    head: () => Promise.reject(new Error("the manifest reads no head")),
    files: async () => files,
    identityOf: (source, mainModule) => moduleIdentityOf(source, mainModule, env, mainModule),
    probe: (source, mainModule) =>
      stub("prj_publication").invoke([
        "itx",
        "workers",
        ["get", { source, mainModule }],
        ["probe"],
      ]),
    appendAsPlatform: () => Promise.reject(new Error("the manifest appends nothing")),
  };
}
