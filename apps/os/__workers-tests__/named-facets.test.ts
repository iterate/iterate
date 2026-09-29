// __workers-tests__/named-facets.test.ts — A FACET NAMED BY A WORKER (context/facet-host.ts
// `#workerOf`): its source `itx.cd('/').config` names the worker the root's rule publishes, as the
// project's config pointer does (src/project/publication.ts), and the facet loads its `mainModule`
// under that module's identity in the worker's manifest. A publication that leaves the module as it
// was leaves the facet running; one that changes it restarts the facet on its next call, storage
// kept; one older than what the facet runs never takes it back. The pointer here is written by
// hand as the platform, its source literal: the rows count restarts by the instance's own id.
// A STATELESS WORKER is named the same way (`workers.get`, context/built-ins.ts `workersRoot`), as an
// installed app's service is: each call loads the module its publication names.
// A NAME ONLY READS RULES, AND ONLY THE PLATFORM VOUCHES FOR A MANIFEST: a name that spells its own
// worker runs no producer anywhere, `itx.config` is written by the platform alone, and a manifest in
// a rule anyone else wrote names no identity — its worker loads as its content.
import { expect, test } from "vitest";
import { configPointer } from "../src/project/publication.ts";
import { appendAsPlatform, readLog, refused, stub, until } from "./support.ts";

test("a facet named by the root's worker keeps running across a publication that leaves its module's identity, restarts on its next call when that changes, and never goes back to an older generation", async () => {
  const project = `prj_named_facet_${crypto.randomUUID().slice(0, 8)}`;
  const boot = async () =>
    (await stub(`${project}.iterate/x`).invoke([
      "itx",
      "facets",
      ["get", "tally", TALLY],
      ["boot"],
    ])) as { version: string; instance: string; count: number };
  await publish(project, { generation: 1, agents: "v1", worker: "w1" });
  const first = await boot();
  expect(first).toMatchObject({ version: "v1", count: 1 });

  // the website changes, agents.ts does not: the same instance answers
  await publish(project, { generation: 2, agents: "v1", worker: "w2" });
  expect(await boot()).toEqual({ ...first, count: 2 });

  // agents.ts changes: its next call restarts it on the new code, its storage kept
  await publish(project, { generation: 3, agents: "v2", worker: "w2" });
  const restarted = await boot();
  expect(restarted).toMatchObject({ version: "v2", count: 3 });
  expect(restarted).not.toMatchObject({ instance: first.instance });

  // a publication older than the one the facet runs — a stale snapshot's — takes it nowhere
  await publish(project, { generation: 2, agents: "v1", worker: "w2" });
  expect(await boot()).toEqual({ ...restarted, count: 4 });
});

test("a caller walks only the methods the code that runs lists: a publication that makes one private refuses it on the call that runs the new code, and one that adds a method admits it there", async () => {
  const project = `prj_named_methods_${crypto.randomUUID().slice(0, 8)}`;
  const call = (method: string) =>
    stub(`${project}.iterate/x`).invoke(["itx", "facets", ["get", "tally", TALLY], [method]]);
  await publish(project, { generation: 1, agents: "v1", worker: "w1", methods: ["boot", "ping"] });
  expect(await call("ping")).toBe("pong");
  await refused(() => call("boot2"), "FORBIDDEN");
  await publish(project, { generation: 2, agents: "v2", worker: "w1", methods: ["boot", "boot2"] });
  expect(await call("boot2")).toEqual({ version: "v2" });
  for (const ping of await Promise.allSettled([call("ping"), call("ping")]))
    expect(ping).toMatchObject({ status: "rejected", reason: { code: "FORBIDDEN" } });
});

test("a stateless worker named by the root's worker loads its mainModule by that module's identity, on the root and through a child's cd, and a publication that changes the module is its next call's code", async () => {
  const project = `prj_named_worker_${crypto.randomUUID().slice(0, 8)}`;
  await stub(project).append(serviceRule("itx.service", "service.ts"));
  const onRoot = () => stub(project).invoke(["itx", "service", ["version"]]);
  const fromChild = () =>
    stub(`${project}.iterate/x`).invoke(["itx", ["cd", "/"], "service", ["version"]]);
  await publish(project, { generation: 1, agents: "v1", worker: "w1" });
  expect([await onRoot(), await fromChild()]).toEqual(["v1", "v1"]);
  await publish(project, { generation: 2, agents: "v2", worker: "w1" });
  expect([await onRoot(), await fromChild()]).toEqual(["v2", "v2"]);
});

test("a worker named for a module its publication does not have is refused, naming the module", async () => {
  const project = `prj_named_worker_missing_${crypto.randomUUID().slice(0, 8)}`;
  await stub(project).append(serviceRule("itx.missing", "missing.ts"));
  await publish(project, { generation: 1, agents: "v1", worker: "w1" });
  let refusal: unknown;
  try {
    await stub(project).invoke(["itx", "missing", ["version"]]);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toMatchObject({
    message: 'workers.get: the worker its source names publishes no module "missing.ts"',
  });
});

test.for([
  {
    drop: "module" as const,
    message: 'facet "tally": the worker its source names publishes no module "agents.ts"',
  },
  {
    drop: "class" as const,
    message:
      'facet "tally": the worker its source names publishes no Durable Object class "Tally" in "agents.ts"',
  },
])(
  "a publication may drop a facet's $drop: the facet's next call fails naming what it names, and the next publication that has it back serves it again",
  async ({ drop, message }) => {
    const project = `prj_named_dropped_${drop}_${crypto.randomUUID().slice(0, 8)}`;
    const boot = () =>
      stub(`${project}.iterate/x`).invoke(["itx", "facets", ["get", "tally", TALLY], ["boot"]]);
    await publish(project, { generation: 1, agents: "v1", worker: "w1" });
    expect(await boot()).toMatchObject({ version: "v1" });
    await publish(project, { generation: 2, agents: "v2", worker: "w1", drop });
    // a plain handler: an RPC rejection `expect().rejects` awaits is reported unhandled in the object
    let refusal: unknown;
    try {
      await boot();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({ message });
    await publish(project, { generation: 3, agents: "v3", worker: "w1" });
    expect(await boot()).toMatchObject({ version: "v3" });
  },
);

test("the published pointer's producer reads the config repo through the fixed point: a rule anyone appends on the root re-points no name it reads, so no other files load under the published identity", async () => {
  const project = `prj_named_producer_${crypto.randomUUID().slice(0, 8)}`;
  const commitOid = crypto.randomUUID().replaceAll("-", "").padEnd(40, "0");
  await stub(project).append(serviceRule("itx.service", "service.ts"));
  // a rule on `/`, anyone's, answering the producer's own spelling with other files
  const substituted = {
    "package.json": '{"main":"service.ts"}',
    "service.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint { version() { return "substituted"; } }`,
  };
  await stub(project).append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.repos.get('/repos/config').modules",
      target: [
        "itx",
        "workers",
        [
          "get",
          {
            source: {
              "package.json": '{"main":"worker.js"}',
              "worker.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint { modules() { return ${JSON.stringify(substituted)}; } }`,
            },
          },
        ],
        "modules",
      ],
    },
  });
  await appendAsPlatform(
    project,
    ...configPointer(commitOid, {
      generation: 1,
      modules: { "service.ts": { identity: "published", classes: [] } },
    }),
  );
  // …and the name the producer does read is the platform's alone
  await refused(
    () =>
      stub(project).append({
        type: "events.iterate.com/itx/rewrite-rule-configured",
        payload: { match: "itx.config.modules", target: "itx.repos.get('/repos/config').modules" },
      }),
    "FORBIDDEN",
  );
  // the project has no config repo here: the published modules are unreadable, never replaced
  let version: unknown;
  try {
    version = await stub(project).invoke(["itx", "service", ["version"]]);
  } catch (error) {
    version = String(error);
  }
  expect(version).not.toBe("substituted");
});

/** A member of the project, as a session's call carries one. */
const MEMBER = { actor: "usr_named_facets", email: "member@example.test" };

test.for([
  { spelling: "cd('/').workers.get", name: ["itx", ["cd", "/"], "workers"] },
  { spelling: "builtins.cd('/')", name: ["itx", "builtins", ["cd", "/"], "workers"] },
  { spelling: "cd('/').builtins.workers", name: ["itx", ["cd", "/"], "builtins", "workers"] },
])(
  "a name that spells its own worker ($spelling) is FORBIDDEN before its producer runs: the root's head does not move",
  async ({ name }) => {
    const project = `prj_named_escape_${crypto.randomUUID().slice(0, 8)}`;
    const head = await bornWithChild(project);
    const escape = {
      className: "Tally",
      source: [
        ...name,
        ["get", { source: ["itx", ["append", { type: "escaped" }]], cacheKey: "k" }],
      ],
    };
    const boot = ["itx", "facets", ["get", "escape", escape], ["boot"]];
    await refused(
      () => stub(`${project}.iterate/c`).invoke(boot, [], { principal: MEMBER }),
      "FORBIDDEN",
    );
    await refused(
      () => stub(`${project}.iterate/c`).invoke(boot, [], { principal: null, app: true }),
      "FORBIDDEN",
    );
    expect(await readLog(project)).toHaveLength(head);
  },
);

test("a manifest in a rule the platform did not write names no identity: a forged one (the largest generation, the pointer's own identity) loads its worker as its content, never the published code's isolate, and pins nothing", async () => {
  const project = `prj_named_forged_${crypto.randomUUID().slice(0, 8)}`;
  const at = (facet: string, spec: unknown) =>
    stub(`${project}.iterate/x`).invoke([
      "itx",
      "facets",
      ["get", facet, spec],
      ["boot"],
    ]) as Promise<{
      version: string;
    }>;
  await publish(project, { generation: 1, agents: "v1", worker: "w1" });
  const forge = (agents: string) =>
    stub(project).append({
      type: "events.iterate.com/itx/rewrite-rule-configured",
      payload: {
        match: "itx.forged",
        target: [
          "itx",
          "builtins",
          "workers",
          [
            "get",
            {
              source: configFiles({ agents, worker: "w1" }),
              manifest: {
                generation: Number.MAX_SAFE_INTEGER,
                modules: { "agents.ts": { identity: "agents-v1", classes: ["Tally"] } },
              },
            },
          ],
        ],
      },
    });
  await forge("evil");
  const FORGED = { ...TALLY, source: ["itx", ["cd", "/"], "forged"] };
  expect(await at("forged", FORGED)).toMatchObject({ version: "evil" });
  expect(await at("tally", TALLY)).toMatchObject({ version: "v1" });
  // its own rule re-pointed, the forged facet follows its content: its generation held nothing
  await forge("evil-2");
  expect(await at("forged", FORGED)).toMatchObject({ version: "evil-2" });
});

/** The project's root with its child `/c` born, and announced on the root: the root's head. */
async function bornWithChild(project: string): Promise<number> {
  await stub(`${project}.iterate/c`).append({ type: "born" });
  const announced = await until("the root knows /c", async () => {
    const log = await readLog(project);
    return log.some((event) => event.type === "events.iterate.com/itx/child-created") && log;
  });
  return announced.length;
}

/** The facet: its class lives in agents.ts of the root's config, named by the pointer. */
const TALLY = {
  className: "Tally",
  mainModule: "agents.ts",
  source: ["itx", ["cd", "/"], "config"],
};

/** A rule naming the stateless worker `mainModule` of the root's config, as an installed app's
 *  service is named (@iterate-com/voice install.ts). */
const serviceRule = (match: string, mainModule: string) => ({
  type: "events.iterate.com/itx/rewrite-rule-configured",
  payload: {
    match,
    target: ["itx", "workers", ["get", { mainModule, source: ["itx", ["cd", "/"], "config"] }]],
  },
});

/** `itx.config` on the project's root, as a publication writes it: the worker's files — agents.ts
 *  at `agents`, the rest at `worker` — and a manifest naming each module by its version; `drop`
 *  leaves agents.ts out, or its Tally. A re-point answers once every snapshot of the old pointer has
 *  expired (context/rule-snapshots.ts). */
async function publish(
  project: string,
  {
    generation,
    agents,
    worker,
    methods,
    drop,
  }: {
    generation: number;
    agents: string;
    worker: string;
    methods?: string[];
    drop?: "module" | "class";
  },
) {
  const files: Record<string, string> = configFiles({ agents, worker, methods });
  const modules: Record<string, { identity: string; classes: string[] }> = {
    "agents.ts": { identity: `agents-${agents}`, classes: drop === "class" ? [] : ["Tally"] },
    "service.ts": { identity: `service-${agents}`, classes: [] },
    "worker.js": { identity: `worker-${worker}`, classes: ["default"] },
  };
  if (drop === "class") files["agents.ts"] = files["agents.ts"]!.replace("export class", "class");
  if (drop === "module") {
    delete files["agents.ts"];
    delete modules["agents.ts"];
  }
  const manifest = { generation, modules };
  await appendAsPlatform(project, {
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.config",
      target: ["itx", "builtins", "workers", ["get", { source: files, manifest }]],
    },
  });
}

/** A config's files: agents.ts's Tally and service.ts's stateless service answer `agents` as their
 *  version, worker.js's homepage is `worker`. */
function configFiles({
  agents,
  worker,
  methods = ["boot"],
}: {
  agents: string;
  worker: string;
  methods?: string[];
}) {
  return {
    "package.json": '{"main":"worker.js"}',
    "worker.js": `import { IterateConfigEntrypoint } from "iterate/sdk";
export const homepage = ${JSON.stringify(worker)};
export default class extends IterateConfigEntrypoint {}`,
    "agents.ts": `import { FacetDurableObject } from "iterate/sdk";
export class Tally extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, ...${JSON.stringify(methods)}];
  instance = crypto.randomUUID();
  boot() {
    const count = (this.ctx.storage.kv.get("count") ?? 0) + 1;
    this.ctx.storage.kv.put("count", count);
    return { version: ${JSON.stringify(agents)}, instance: this.instance, count };
  }
  ping() {
    return "pong";
  }
  boot2() {
    return { version: ${JSON.stringify(agents)} };
  }
}`,
    "service.ts": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  version() {
    return ${JSON.stringify(agents)};
  }
}`,
  };
}
