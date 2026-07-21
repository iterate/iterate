import { expect, test } from "vitest";
import { uniqueFixtureSlug } from "@iterate-com/shared/test-support/fixture-slug";
import type { DynamicWorkerRef } from "../../src/domains/workers/schemas.ts";
import { itxScript } from "../test-support/itx-script-builder.ts";
import { inlineJsSource } from "./itx-test-support.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test("Project repos, workers, runScript, and dynamic worker refs compose", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = await itx.projects
    .get(`dynamic-worker-${crypto.randomUUID().slice(0, 8)}`)
    .create({});
  const description = await project.__describe();

  // The seeded root worker routes via x-iterate-app (static homepage
  // otherwise); an unknown selection echoes back in the 404 body, giving the
  // script a request-specific probe through the fetch lane with no app cold
  // build.
  const scriptResult = await itxScript(project.capabilityHost).execute(async (itx) => {
    const response = await itx.worker.fetch(
      new Request("https://example.com/script", { headers: { "x-iterate-app": "script-probe" } }),
    );
    return {
      repo: await itx.repo.whoami(),
      sandboxCreate: typeof itx.sandboxes.get("/sandboxes/surface-probe").create,
      worker: `${response.status} ${await response.text()}`,
    };
  });
  expect(scriptResult.success()).toEqual({
    repo: `repo ${description.projectId}:/repos/config`,
    sandboxCreate: "function",
    worker: "404 unknown app: script-probe",
  });

  const commit = await project.repo.commitFiles({
    changes: [
      {
        path: "worker.ts",
        content: `
            import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch(req) {
                return new Response(\`updated project worker fetched \${new URL(req.url).pathname}\`);
              }

              someMethod() {
                return {
                  projectId: ${JSON.stringify(description.projectId)},
                  source: "committed-worker",
                };
              }

              processEventBatch(batch) {
                console.log("updated project worker processed", batch.events.length, "events");
              }
            }

            export class CounterDurableObject extends DurableObject {
              async increment() {
                const n = ((this.ctx.storage.kv.get("n")) ?? 0) + 1;
                this.ctx.storage.kv.put("n", n);
                return n;
              }

              async current() {
                return this.ctx.storage.kv.get("n") ?? 0;
              }
            }

            export class DatabaseDurableObject extends DurableObject {
              sql(query, ...bindings) {
                return this.ctx.storage.sql.exec(query, ...bindings).toArray();
              }
            }
          `,
      },
    ],
    message: "Add someMethod to project worker",
  });
  expect(commit).toMatchObject({
    branch: "main",
    changedPaths: ["worker.ts"],
    noChanges: false,
  });
  expect(commit.commitOid).toMatch(/^[0-9a-f]{40}$/);
  // @ts-expect-error - dynamic project worker method from committed source
  expect(await project.worker.someMethod()).toEqual({
    projectId: description.projectId,
    source: "committed-worker",
  });

  using explicitWorker = project.workers.get({
    path: "/",
    source: {
      createWorker: {
        entryPoint: "worker.ts",
        files: { repoPath: "/repos/config", type: "repo" },
      },
    },
    type: "stateless",
  }) as unknown as {
    someMethod(): Promise<{ projectId: string; source: string }>;
  } & Disposable;
  expect(await explicitWorker.someMethod()).toEqual({
    projectId: description.projectId,
    source: "committed-worker",
  });

  using directDb = project.workers.get({
    className: "DatabaseDurableObject",
    durableWorkerKey: `direct-db-${crypto.randomUUID()}`,
    path: "/",
    source: {
      createWorker: {
        entryPoint: "worker.ts",
        files: { repoPath: "/repos/config", type: "repo" },
      },
    },
    type: "stateful",
  }) as unknown as {
    sql(query: string, ...bindings: unknown[]): Promise<Array<Record<string, unknown>>>;
  } & Disposable;
  await directDb.sql("CREATE TABLE messages (body TEXT)");
  await directDb.sql("INSERT INTO messages VALUES (?)", "hello");
  expect(await directDb.sql("SELECT body FROM messages")).toEqual([{ body: "hello" }]);
  using _probeProvision = await project.provideCapability({
    expression: [
      "workers",
      [
        "get",
        {
          entrypoint: "ProbeEntrypoint",
          path: "/",
          source: inlineJsSource("probe.js", {
            "probe.js": `
                import { WorkerEntrypoint } from "cloudflare:workers";

                export class ProbeEntrypoint extends WorkerEntrypoint {
                  async inspect() {
                    const project = await this.env.ITX.get();
                    const repo = await project.repo;
                    return {
                      repo: await repo.whoami(),
                    };
                  }
                }
              `,
          }),
          type: "stateless",
        },
      ],
    ],
    path: ["probe"],
    type: "itx-expression",
  });
  // @ts-expect-error - dynamic capability root
  expect(await project.probe.inspect()).toEqual({
    repo: `repo ${description.projectId}:/repos/config`,
  });

  using _projectWorkerRefProvision = await project.provideCapability({
    expression: [
      "workers",
      [
        "get",
        {
          path: "/",
          source: {
            createWorker: {
              entryPoint: "worker.ts",
              files: { repoPath: "/repos/config", type: "repo" },
            },
          },
          type: "stateless",
        },
      ],
    ],
    path: ["projectWorkerRef"],
    type: "itx-expression",
  });
  // @ts-expect-error - dynamic capability root
  const workerRefResponse = await project.projectWorkerRef.fetch(
    new Request("https://example.com/ref"),
  );
  expect(await workerRefResponse.text()).toBe("updated project worker fetched /ref");

  using _counterFacetProvision = await project.provideCapability({
    expression: [
      "workers",
      [
        "get",
        {
          className: "CounterDurableObject",
          durableWorkerKey: `counter-facet-${crypto.randomUUID()}`,
          path: "/",
          source: {
            createWorker: {
              entryPoint: "worker.ts",
              files: { repoPath: "/repos/config", type: "repo" },
            },
          },
          type: "stateful",
        },
      ],
    ],
    path: ["counterFacet"],
    type: "itx-expression",
  });
  // @ts-expect-error - dynamic capability root
  expect(await project.counterFacet.increment()).toBe(1);
  // @ts-expect-error - dynamic capability root
  expect(await project.counterFacet.current()).toBe(1);

  using _dbProvision = await project.provideCapability({
    expression: [
      "workers",
      [
        "get",
        {
          className: "DatabaseDurableObject",
          durableWorkerKey: `mounted-db-${crypto.randomUUID()}`,
          path: "/",
          source: {
            createWorker: {
              entryPoint: "worker.ts",
              files: { repoPath: "/repos/config", type: "repo" },
            },
          },
          type: "stateful",
        },
      ],
    ],
    path: ["db"],
    type: "itx-expression",
  });
  // @ts-expect-error - dynamic database capability mounted by this test.
  await project.db.sql("CREATE TABLE records (value TEXT)");
  // @ts-expect-error - dynamic database capability mounted by this test.
  await project.db.sql("INSERT INTO records VALUES (?)", "mounted");
  // @ts-expect-error - dynamic database capability mounted by this test.
  expect(await project.db.sql("SELECT value FROM records")).toEqual([{ value: "mounted" }]);
});

test("deleting the main worker file makes the next project worker build fail", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = await itx.projects
    .get(`deleted-worker-${crypto.randomUUID().slice(0, 8)}`)
    .create({});
  // The seeded root worker serves a static homepage; this warm-up only needs
  // proof the seeded worker.ts is live before we delete it.
  const warmResponse = await project.worker.fetch(new Request("https://example.com/warm"));
  expect(await warmResponse.text()).toContain("Hello from your iterate project worker");

  await project.repo.commitFiles({
    changes: [{ delete: true, path: "worker.ts" }],
    message: "Delete default project worker",
  });

  // The commit moved the branch head, so the next use resolves a new build
  // key, and that build has no entry point to bundle.
  await expect(project.worker.fetch(new Request("https://example.com/warm"))).rejects.toThrow();
});

test("Worker expression capabilities dispatch nested RpcTarget paths", async () => {
  const marker = crypto.randomUUID();
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`worker-flatten-${marker}`).create({});

  const source = {
    createWorker: {
      bundle: false,
      entryPoint: "router.js",
      files: {
        type: "inline",
        files: {
          "router.js": `
          import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

          class ToolsTarget extends RpcTarget {
            constructor(kind) {
              super();
              this.kind = kind;
            }

            echo(input) {
              return {
                args: [input],
                kind: this.kind,
                marker: ${JSON.stringify(marker)},
                path: ["tools", "echo"],
              };
            }
          }

          export class RouterEntrypoint extends WorkerEntrypoint {
            get tools() {
              return new ToolsTarget("stateless");
            }

            root(input) {
              return {
                args: [input],
                kind: "stateless",
                marker: ${JSON.stringify(marker)},
                path: ["root"],
              };
            }
          }

          export class RouterDurableObject extends DurableObject {
            get tools() {
              return new ToolsTarget("stateful");
            }
          }
        `,
        },
      },
    },
  } as const;

  using _statelessRouterProvision = await project.provideCapability({
    expression: [
      "workers",
      [
        "get",
        {
          entrypoint: "RouterEntrypoint",
          path: "/",
          source,
          type: "stateless",
        },
      ],
    ],
    path: ["statelessRouter"],
    type: "itx-expression",
  });
  // @ts-expect-error - dynamic capability root
  expect(await project.statelessRouter.tools.echo("hello")).toEqual({
    args: ["hello"],
    kind: "stateless",
    marker,
    path: ["tools", "echo"],
  });
  // @ts-expect-error - dynamic capability root
  expect(await project.statelessRouter.root("root")).toEqual({
    args: ["root"],
    kind: "stateless",
    marker,
    path: ["root"],
  });

  using _statefulRouterProvision = await project.provideCapability({
    expression: [
      "workers",
      [
        "get",
        {
          className: "RouterDurableObject",
          durableWorkerKey: `router-${crypto.randomUUID()}`,
          path: "/",
          source,
          type: "stateful",
        },
      ],
    ],
    path: ["statefulRouter"],
    type: "itx-expression",
  });
  // @ts-expect-error - dynamic capability root
  expect(await project.statefulRouter.tools.echo("hello")).toEqual({
    args: ["hello"],
    kind: "stateful",
    marker,
    path: ["tools", "echo"],
  });
});

test("Dynamic workers can return RpcTarget capabilities that keep chaining", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects.get(`returned-rpc-target-${crypto.randomUUID()}`).create({});

  type ReturnedTool = {
    child: { value(): Promise<{ label: string; via: string }> };
    greet(name: string): Promise<{ greeting: string; via: string }>;
  };
  type FactoryWorker = Disposable & {
    defaultTool: ReturnedTool;
    makeTool(label: string): PromiseLike<ReturnedTool> & ReturnedTool;
  };

  const source = {
    createWorker: {
      bundle: false,
      entryPoint: "returned-rpc-target.js",
      files: {
        type: "inline",
        files: {
          "returned-rpc-target.js": `
          import { DurableObject, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

          class ChildTarget extends RpcTarget {
            constructor(label) {
              super();
              this.label = label;
            }

            value() {
              return { label: this.label, via: "child-target" };
            }
          }

          class ToolTarget extends RpcTarget {
            constructor(label) {
              super();
              this.label = label;
            }

            greet(name) {
              return { greeting: this.label + ":" + name, via: "tool-target" };
            }

            get child() {
              return new ChildTarget(this.label);
            }
          }

          export class FactoryEntrypoint extends WorkerEntrypoint {
            get defaultTool() {
              return new ToolTarget("stateless-getter");
            }

            makeTool(label) {
              return new ToolTarget(label);
            }
          }

          export class FactoryDurableObject extends DurableObject {
            get defaultTool() {
              return new ToolTarget("stateful-getter");
            }

            makeTool(label) {
              return new ToolTarget(label);
            }
          }
        `,
        },
      },
    },
  } as const;

  using statelessWorker = project.workers.get({
    entrypoint: "FactoryEntrypoint",
    path: "/",
    source,
    type: "stateless",
  }) as unknown as FactoryWorker;
  const statelessTool = await statelessWorker.makeTool("stateless-awaited");
  expect(await statelessTool.greet("Ada")).toEqual({
    greeting: "stateless-awaited:Ada",
    via: "tool-target",
  });
  expect(await statelessTool.child.value()).toEqual({
    label: "stateless-awaited",
    via: "child-target",
  });
  expect(await statelessWorker.makeTool("stateless-pipelined").greet("Bob")).toEqual({
    greeting: "stateless-pipelined:Bob",
    via: "tool-target",
  });
  expect(await statelessWorker.defaultTool.greet("Grace")).toEqual({
    greeting: "stateless-getter:Grace",
    via: "tool-target",
  });
  expect(await statelessWorker.defaultTool.child.value()).toEqual({
    label: "stateless-getter",
    via: "child-target",
  });

  using statefulWorker = project.workers.get({
    className: "FactoryDurableObject",
    durableWorkerKey: `returned-target-${crypto.randomUUID()}`,
    path: "/",
    source,
    type: "stateful",
  }) as unknown as FactoryWorker;
  const statefulTool = await statefulWorker.makeTool("stateful-awaited");
  expect(await statefulTool.greet("Ada")).toEqual({
    greeting: "stateful-awaited:Ada",
    via: "tool-target",
  });
  expect(await statefulTool.child.value()).toEqual({
    label: "stateful-awaited",
    via: "child-target",
  });
  expect(await statefulWorker.makeTool("stateful-pipelined").greet("Bob")).toEqual({
    greeting: "stateful-pipelined:Bob",
    via: "tool-target",
  });
  expect(await statefulWorker.defaultTool.greet("Grace")).toEqual({
    greeting: "stateful-getter:Grace",
    via: "tool-target",
  });
  expect(await statefulWorker.defaultTool.child.value()).toEqual({
    label: "stateful-getter",
    via: "child-target",
  });
});

test("Worker capabilities cover project/agent, stateful/stateless, repo/inline refs and env.ITX cross-calls", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });

  using project = await itx.projects.get(uniqueFixtureSlug("worker-capability-matrix")).create({});
  const { projectId } = await project.__describe();
  const agentPath = `/agents/worker-capability-${crypto.randomUUID()}`;
  using agent = project.agents.get(agentPath);
  await agent.create();

  await project.repo.commitFiles({
    changes: [
      {
        path: "worker.ts",
        content: `
            import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

            export default class ProjectWorker extends WorkerEntrypoint {
              fetch(req) {
                return new Response(\`matrix project worker \${new URL(req.url).pathname}\`);
              }

              processEventBatch(batch) {
                console.log("matrix project worker processed", batch.events.length, "events");
              }
            }

            export class RepoProjectCounterDurableObject extends DurableObject {
              async increment(label) {
                const count = ((this.ctx.storage.kv.get("count")) ?? 0) + 1;
                this.ctx.storage.kv.put("count", count);
                const project = await this.env.ITX.get();
                const description = await project.__describe();
                return {
                  count,
                  label,
                  scope: \`project:\${description.projectId}\`,
                };
              }
            }

            export class RepoAgentEntrypoint extends WorkerEntrypoint {
              async echo(label) {
                const itx = await this.env.ITX.get();
                return {
                  label,
                  whoami: (await itx.agent.__describe()).whoami,
                };
              }
            }
          `,
      },
    ],
    message: "Add worker capability matrix fixtures",
  });

  const repoWorkerSource = {
    createWorker: {
      entryPoint: "worker.ts",
      files: { repoPath: "/repos/config", type: "repo" },
    },
  } as const;
  const inlineProjectStateless: DynamicWorkerRef = {
    entrypoint: "InlineProjectEntrypoint",
    path: "/",
    source: inlineJsSource("inline-project.js", {
      "inline-project.js": `
          import { WorkerEntrypoint } from "cloudflare:workers";

          export class InlineProjectEntrypoint extends WorkerEntrypoint {
            async describeScope() {
              const project = await this.env.ITX.get();
              const description = await project.__describe();
              return {
                projectId: description.projectId,
                via: "inline-project-stateless",
              };
            }

            async callRepoCounter(label) {
              const project = await this.env.ITX.get();
              return await project.repoCounter.increment(label);
            }
          }
        `,
    }),
    type: "stateless",
  };
  const inlineAgentStateful: DynamicWorkerRef = {
    className: "InlineAgentCounterDurableObject",
    durableWorkerKey: `inline-agent-counter-${crypto.randomUUID()}`,
    path: agentPath,
    source: inlineJsSource("inline-agent-counter.js", {
      "inline-agent-counter.js": `
          import { DurableObject } from "cloudflare:workers";

          export class InlineAgentCounterDurableObject extends DurableObject {
            async increment(label) {
              const count = ((this.ctx.storage.kv.get("count")) ?? 0) + 1;
              this.ctx.storage.kv.put("count", count);
              const itx = await this.env.ITX.get();
              return {
                count,
                label,
                whoami: (await itx.agent.__describe()).whoami,
              };
            }

            async callRepoAgent(label) {
              const itx = await this.env.ITX.get();
              // repoAgent is mounted on the agent scope this DO runs in, so
              // it is a member of the scope's own itx. (It is equally
              // reachable as itx.agent.repoAgent via the handle's
              // prototype-chain fallback — this spelling is the canonical
              // one for a capability in your own scope.)
              return await itx.repoAgent.echo(label);
            }
          }
        `,
    }),
    type: "stateful",
  };

  using _repoCounterProvision = await project.provideCapability({
    expression: [
      "workers",
      [
        "get",
        {
          className: "RepoProjectCounterDurableObject",
          durableWorkerKey: `repo-project-counter-${crypto.randomUUID()}`,
          path: "/",
          source: repoWorkerSource,
          type: "stateful",
        },
      ],
    ],
    path: ["repoCounter"],
    type: "itx-expression",
  });
  using _inlineProjectProvision = await project.provideCapability({
    expression: ["workers", ["get", inlineProjectStateless]],
    path: ["inlineProject"],
    type: "itx-expression",
  });
  using _repoAgentProvision = await agent.provideCapability({
    expression: [
      "workers",
      [
        "get",
        {
          entrypoint: "RepoAgentEntrypoint",
          path: agentPath,
          source: repoWorkerSource,
          type: "stateless",
        },
      ],
    ],
    path: ["repoAgent"],
    type: "itx-expression",
  });
  using _inlineCounterProvision = await agent.provideCapability({
    expression: ["workers", ["get", inlineAgentStateful]],
    path: ["inlineCounter"],
    type: "itx-expression",
  });

  const projectCapabilities = project as typeof project & {
    inlineProject: {
      callRepoCounter(label: string): Promise<{ count: number; label: string; scope: string }>;
      describeScope(): Promise<{ projectId: string; via: string }>;
    };
    repoCounter: {
      increment(label: string): Promise<{ count: number; label: string; scope: string }>;
    };
  };
  // The agent HANDLE is a plain, unproxied instance (so `agents.get(...)`
  // results pipeline over workerd RPC — see AgentRpcTarget); its dynamic
  // capabilities dispatch via the prototype-chain fallback, and the
  // capabilityHost property is the equivalent explicit door exercised here.
  const agentCapabilities = agent.capabilityHost as typeof agent.capabilityHost & {
    inlineCounter: {
      callRepoAgent(label: string): Promise<{ label: string; whoami: string }>;
      increment(label: string): Promise<{ count: number; label: string; whoami: string }>;
    };
    repoAgent: {
      echo(label: string): Promise<{ label: string; whoami: string }>;
    };
  };

  expect(await projectCapabilities.inlineProject.describeScope()).toEqual({
    projectId,
    via: "inline-project-stateless",
  });
  expect(await projectCapabilities.repoCounter.increment("direct-project-durable")).toEqual({
    count: 1,
    label: "direct-project-durable",
    scope: `project:${projectId}`,
  });
  expect(await projectCapabilities.inlineProject.callRepoCounter("project-cross-call")).toEqual({
    count: 2,
    label: "project-cross-call",
    scope: `project:${projectId}`,
  });

  expect(await agentCapabilities.repoAgent.echo("direct-agent-stateless")).toEqual({
    label: "direct-agent-stateless",
    whoami: `agent ${projectId}:${agentPath}`,
  });
  expect(await agentCapabilities.inlineCounter.increment("direct-agent-durable")).toEqual({
    count: 1,
    label: "direct-agent-durable",
    whoami: `agent ${projectId}:${agentPath}`,
  });
  expect(await agentCapabilities.inlineCounter.callRepoAgent("agent-cross-call")).toEqual({
    label: "agent-cross-call",
    whoami: `agent ${projectId}:${agentPath}`,
  });
});
