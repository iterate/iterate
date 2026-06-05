import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import dedent from "dedent";
import WebSocket from "ws";
import { Redacted } from "@iterate-com/shared/apps/config";
import {
  requireAdminBearerToken,
  requireBaseUrl,
  uniqueSuffix,
} from "../test-support/os-client.ts";
import type { IterateCapability } from "~/capnweb-playground.ts";

const baseUrl = requireBaseUrl();

// We want to prove that the same codemode snippet can be executed from both
// 1) inside a dynamic worker that is passed the iterate capability as RpcTarget
// 2) from within this vitest runner after creating a capnweb capability
// 3) (later) from a workers for platform deployment
const runWithIterateContexts = [
  {
    name: "over the websocket endpoint",
    async runWithIterateContext<Result, Vars extends CaptnwebVars = CaptnwebVars>(
      input: RunWithIterateContextInput<Result, Vars>,
    ) {
      using iterate = withIterateFromNode({
        baseUrl,
        auth: adminAuth({ scopes: input.scopes }),
      });
      return await input.fn({ iterate, vars: input.vars ?? ({} as Vars) });
    },
  },
  {
    name: "inside /run dynamic worker",
    async runWithIterateContext<Result, Vars extends CaptnwebVars = CaptnwebVars>(
      input: RunWithIterateContextInput<Result, Vars>,
    ) {
      const response = await fetch(new URL("/api/captnweb/run", baseUrl), {
        method: "POST",
        headers: {
          ...adminAuthHeaders(adminAuth({ scopes: input.scopes })),
          "content-type": "application/json",
        },
        body: JSON.stringify({ code: stringifySnippet(input.fn), vars: input.vars }),
      });
      if (!response.ok) {
        const body = await response.text();
        let message = body;
        try {
          message = ((JSON.parse(body) as { error?: string }).error ?? body).trim();
        } catch {
          message = body.trim();
        }
        throw new Error(message || `captnweb /run failed (${response.status})`);
      }
      return (await response.json()) as Awaited<ReturnType<typeof input.fn>>;
    },
  },
];

/**
 * End-to-end coverage for the captnweb capability endpoint.
 *
 * Each connection authenticates with the admin API secret and assumes a chosen
 * set of project scopes — that's how a single admin token exercises many scope
 * combinations. Project capabilities are backed by real disposable projects so
 * the tests exercise the same existence checks as production code.
 */

describe("captnweb", () => {
  // Used as prefix for project slugs so we can later assert that we've deleted them all
  const testRunSlugPrefix = `captnweb-${crypto.randomUUID().slice(0, 8)}`;
  afterAll(async () => {
    const remaining = await listProjectsWithSlugPrefix(testRunSlugPrefix);
    expect(remaining).toEqual([]);
  });

  describe("with admin auth", () => {
    for (const { name, runWithIterateContext } of runWithIterateContexts) {
      describe(name, () => {
        let alphaProject: CreatedProject;
        let betaProject: CreatedProject;

        beforeAll(async () => {
          alphaProject = await createCaptnwebProject({
            runWithIterateContext,
            slug: `${testRunSlugPrefix}-alpha-${uniqueSuffix()}`.slice(0, 40),
          });
          betaProject = await createCaptnwebProject({
            runWithIterateContext,
            slug: `${testRunSlugPrefix}-beta-${uniqueSuffix()}`.slice(0, 40),
          });
        });

        afterAll(async () => {
          await Promise.all(
            [alphaProject, betaProject].map((project) =>
              project
                ? removeCaptnwebProject({ project, runWithIterateContext }).catch(() => undefined)
                : undefined,
            ),
          );
        });

        it("enforces project scopes against real projects", async () => {
          const scopes = [`project:${alphaProject.id}`, `project:${betaProject.id}`];
          const deletedProject = await createCaptnwebProject({
            runWithIterateContext,
            slug: `${testRunSlugPrefix}-deleted-${uniqueSuffix()}`.slice(0, 40),
          });
          await removeCaptnwebProject({ project: deletedProject, runWithIterateContext });

          const result = await runWithIterateContext({
            scopes,
            fn: async ({ iterate }) => {
              const list = await iterate.projects.list();
              return {
                current: await iterate.project.describe(),
                list,
                whoami: await iterate.whoami(),
              };
            },
          });

          expect(result.whoami.scopes).toEqual(scopes);
          expect(result.current).toMatchObject({ id: alphaProject.id, slug: alphaProject.slug });
          expect(result.list).toMatchObject({
            total: 2,
            projects: [
              { id: alphaProject.id, slug: alphaProject.slug },
              { id: betaProject.id, slug: betaProject.slug },
            ],
          });

          await expect(
            runWithIterateContext({
              scopes: [`project:${alphaProject.id}`],
              vars: { projectId: betaProject.id },
              fn: async ({ iterate, vars }) => iterate.projects.get(vars.projectId).describe(),
            }),
          ).rejects.toThrow(new RegExp(`Not authorized for project: ${betaProject.id}`));
          await expect(
            runWithIterateContext({
              scopes: [`project:${deletedProject.id}`],
              vars: { projectId: deletedProject.id },
              fn: async ({ iterate, vars }) => iterate.projects.get(vars.projectId).describe(),
            }),
          ).rejects.toThrow(new RegExp(`Project ${deletedProject.id} not found`));
        });

        it("handles wildcard access without inventing a current project", async () => {
          const result = await runWithIterateContext({
            scopes: ["project:*"],
            vars: { projectId: betaProject.id },
            fn: async ({ iterate, vars }) => {
              return {
                current: await Promise.resolve()
                  .then(() => iterate.project.describe())
                  .then(
                    () => "found",
                    (error) => (error instanceof Error ? error.message : String(error)),
                  ),
                described: await iterate.projects.get(vars.projectId).describe(),
                list: await iterate.projects.list({ limit: 1_000 }),
              };
            },
          });

          expect(result.current).toBe("No current project is available for these scopes.");
          expect(result.described).toMatchObject({ id: betaProject.id, slug: betaProject.slug });
          expect(result.list.projects).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: alphaProject.id, slug: alphaProject.slug }),
              expect.objectContaining({ id: betaProject.id, slug: betaProject.slug }),
            ]),
          );
        });

        it("creates and removes a real project", async () => {
          const project = await createCaptnwebProject({
            runWithIterateContext,
            slug: `${testRunSlugPrefix}-create-${uniqueSuffix()}`.slice(0, 40),
          });
          try {
            expect(project.id).toMatch(/^proj_/);
            expect(project.ingressUrl).toContain(project.slug);
            expect(
              await runWithIterateContext({
                scopes: [`project:${project.id}`],
                fn: async ({ iterate }) => ({
                  described: await iterate.project.describe(),
                  list: await iterate.projects.list(),
                }),
              }),
            ).toMatchObject({
              described: { id: project.id, slug: project.slug },
              list: { projects: [{ id: project.id, slug: project.slug }] },
            });
            const removed = await removeCaptnwebProject({ project, runWithIterateContext });
            expect(removed).toEqual({ ok: true, id: project.id, deleted: true });
          } finally {
            await removeCaptnwebProject({ project, runWithIterateContext }).catch(() => undefined);
          }
        });

        it("appends and reads project stream events", async () => {
          const streamPath = `/captnweb/${uniqueSuffix()}`;
          const eventType = "events.iterate.com/captnweb/e2e-proof";
          const marker = `captnweb-stream-${uniqueSuffix()}`;

          const result = await runWithIterateContext({
            scopes: [`project:${alphaProject.id}`],
            vars: { eventType, marker, streamPath },
            fn: async ({ iterate, vars }) => {
              const appended = await iterate.project.streams.append({
                streamPath: vars.streamPath,
                event: {
                  type: vars.eventType,
                  payload: { marker: vars.marker },
                },
              });
              const events = await iterate.project.streams.read({
                afterOffset: "start",
                streamPath: vars.streamPath,
              });
              return { appended, events };
            },
          });

          expect(result.appended).toMatchObject({
            offset: expect.any(Number),
            payload: { marker },
            type: eventType,
          });
          expect(result.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                offset: result.appended.offset,
                payload: { marker },
                type: eventType,
              }),
            ]),
          );
        });

        it("updates iterate-config and calls the project worker through capnweb", async () => {
          const project = await createCaptnwebProject({
            runWithIterateContext,
            slug: `${testRunSlugPrefix}-worker-${uniqueSuffix()}`.slice(0, 40),
          });
          try {
            const marker = `captnweb-worker-${uniqueSuffix()}`;
            const streamPath = `/captnweb/worker/${marker}`;
            const eventType = `events.iterate.com/captnweb/worker/${marker}`;
            const workerSource = dedent`
              export default {
                async fetch(request, env) {
                  const url = new URL(request.url);
                  const project = await env.ITERATE.project();
                  const streamPath = url.searchParams.get("streamPath");
                  const eventType = url.searchParams.get("eventType");
                  const marker = url.searchParams.get("marker");
                  const appended = await project.streams.append({
                    streamPath,
                    event: {
                      type: eventType,
                      payload: {
                        marker,
                        source: "iterate-config",
                      },
                    },
                  });
                  const events = await project.streams.read({
                    afterOffset: "start",
                    streamPath,
                  });
                  return Response.json({
                    appended: {
                      eventType: appended.type,
                      marker: appended.payload.marker,
                      offset: appended.offset,
                      streamPath,
                    },
                    events,
                  });
                },
                async someFunction(input = {}) {
                  return { from: "iterate-config", input, marker: ${JSON.stringify(marker)} };
                },
              };
            `;

            const result = await runWithIterateContext({
              scopes: [`project:${project.id}`],
              vars: {
                eventType,
                fetchUrl: `https://iterate-config.local/captnweb-fetch/${marker}?${new URLSearchParams(
                  {
                    eventType,
                    marker,
                    streamPath,
                  },
                )}`,
                marker,
                streamPath,
                workerSource,
              },
              fn: async ({ iterate, vars }) => {
                await iterate.project.streams.append({
                  streamPath: `/captnweb/worker/${Date.now()}`,
                  event: {
                    type: "events.iterate.com/captnweb/config-edit-started",
                    payload: { marker: vars.marker },
                  },
                });

                const repo = await iterate.project.repos.ensureIterateConfigInfo({
                  projectSlug: null,
                });
                const dir = `/iterate-config-${Date.now()}`;
                await iterate.project.workspace.git.clone({
                  url: repo.remote,
                  dir,
                  branch: repo.defaultBranch,
                  depth: 1,
                  ...repo.credentials,
                });
                await iterate.project.workspace.writeFile(`${dir}/worker.js`, vars.workerSource);
                await iterate.project.workspace.git.add({ dir, filepath: "worker.js" });
                const commit = await iterate.project.workspace.git.commit({
                  dir,
                  message: "Add captnweb worker proof",
                  author: { name: "Capnweb", email: "captnweb-e2e@iterate.com" },
                });
                await iterate.project.workspace.git.push({
                  dir,
                  remote: "origin",
                  ref: repo.defaultBranch,
                  ...repo.credentials,
                });
                const streamFetch = (await iterate.project.worker.fetchJson({
                  url: vars.fetchUrl,
                })) as {
                  appended: unknown;
                  events: unknown[];
                };

                return {
                  called: await iterate.project.worker.someFunction({
                    echo: vars.marker,
                  }),
                  commit,
                  repo: { defaultBranch: repo.defaultBranch, slug: repo.slug },
                  status: await iterate.project.workspace.git.status({ dir }),
                  streamFetch,
                  streamEvents: await iterate.project.streams.read({
                    afterOffset: "start",
                    streamPath: vars.streamPath,
                  }),
                };
              },
            });
            expect(result).toMatchObject({
              commit: { oid: expect.any(String) },
              repo: { defaultBranch: "main", slug: "iterate-config" },
              status: [],
            });
            expect(result.called).toEqual({
              from: "iterate-config",
              input: { echo: marker },
              marker,
            });
            expect(result.streamFetch.appended).toMatchObject({
              eventType,
              marker,
              offset: expect.any(Number),
              streamPath,
            });
            expect(result.streamFetch.events).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: eventType,
                  payload: {
                    marker,
                    source: "iterate-config",
                  },
                }),
              ]),
            );
            expect(result.streamEvents).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: eventType,
                  payload: {
                    marker,
                    source: "iterate-config",
                  },
                }),
              ]),
            );
          } finally {
            await removeCaptnwebProject({ project, runWithIterateContext }).catch(() => undefined);
          }
        });

        it("surfaces errors thrown by snippets and capabilities", async () => {
          await expect(
            runWithIterateContext({
              scopes: [`project:${alphaProject.id}`],
              fn: async () => {
                throw new Error("Snippet exploded");
              },
            }),
          ).rejects.toThrow("Snippet exploded");

          await expect(
            runWithIterateContext({
              scopes: [`project:${alphaProject.id}`],
              fn: async ({ iterate }) =>
                iterate.testMethod({ behavior: "throw", message: "Bla bla" }),
            }),
          ).rejects.toThrow("Bla bla");
        });
      });
    }
  });
});

function withIterateFromNode(input: {
  baseUrl: string;
  auth?: {
    type: "admin";
    scopes: string[];
    token: Redacted<string>;
  };
}): RpcStub<IterateCapability> {
  const wsUrl = new URL("/api/captnweb", input.baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

  const headers: Record<string, string> = {};
  if (input.auth) {
    headers.Authorization = `Bearer ${input.auth.token.exposeSecret()}`;
    headers["x-iterate-scopes"] = input.auth.scopes.join(",");
  }

  const socket = new WebSocket(wsUrl.toString(), { headers });
  // `ws`'s WebSocket is structurally compatible with what capnweb consumes
  // (addEventListener / send / close), but not type-identical to the global.
  return newWebSocketRpcSession<IterateCapability>(
    socket as unknown as Parameters<typeof newWebSocketRpcSession>[0],
  );
}

function adminAuth({ scopes }: { scopes: string[] }) {
  return {
    type: "admin" as const,
    scopes,
    token: new Redacted(requireAdminBearerToken()),
  };
}

type AdminAuth = ReturnType<typeof adminAuth>;

function adminAuthHeaders(auth: AdminAuth) {
  return {
    Authorization: `Bearer ${auth.token.exposeSecret()}`,
    "x-iterate-scopes": auth.scopes.join(","),
  };
}

type CaptnwebVars = Record<string, unknown>;

type CaptnwebSnippetInput<Vars extends CaptnwebVars> = {
  iterate: RpcStub<IterateCapability>;
  vars: Vars;
};

type CaptnwebSnippet<Result, Vars extends CaptnwebVars> = (
  input: CaptnwebSnippetInput<Vars>,
) => Promise<Result>;

type RunWithIterateContextInput<Result, Vars extends CaptnwebVars = CaptnwebVars> = {
  scopes: string[];
  fn: CaptnwebSnippet<Result, Vars>;
  vars?: Vars;
};

type CreatedProject = {
  id: string;
  slug: string;
  ingressUrl: string;
};

type RunWithIterateContext = (typeof runWithIterateContexts)[number]["runWithIterateContext"];

async function createCaptnwebProject(input: {
  runWithIterateContext: RunWithIterateContext;
  slug: string;
}): Promise<CreatedProject> {
  return await input.runWithIterateContext({
    scopes: ["create_project"],
    vars: { slug: input.slug },
    fn: async ({ iterate, vars }) => iterate.projects.create({ slug: vars.slug }),
  });
}

async function removeCaptnwebProject(input: {
  project: CreatedProject;
  runWithIterateContext: RunWithIterateContext;
}) {
  return await input.runWithIterateContext({
    scopes: [`project:${input.project.id}`],
    vars: { id: input.project.id },
    fn: async ({ iterate, vars }) => iterate.projects.remove({ id: vars.id }),
  });
}

async function listProjectsWithSlugPrefix(prefix: string) {
  const matches: Array<{ id: string; slug: string }> = [];
  const limit = 100;
  for (let offset = 0; ; offset += limit) {
    const page = await runWithIterateContexts[0].runWithIterateContext({
      scopes: ["project:*"],
      vars: { limit, offset },
      fn: async ({ iterate, vars }) =>
        iterate.projects.list({ limit: vars.limit, offset: vars.offset }),
    });
    matches.push(...page.projects.filter((project) => project.slug.startsWith(prefix)));
    if (offset + page.projects.length >= page.total || page.projects.length === 0) {
      return matches;
    }
  }
}

function stringifySnippet<Result, Vars extends CaptnwebVars>(fn: CaptnwebSnippet<Result, Vars>) {
  const code = fn.toString();
  return code.startsWith("async ") ? code : `async ${code}`;
}
