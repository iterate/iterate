import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
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
        const error = (await response.json()) as { error?: string };
        throw new Error(error.error ?? `captnweb /run failed (${response.status})`);
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
 * combinations. The capability data is the hardcoded/dummy implementation, so
 * assertions are deterministic.
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
        describe('with scopes ["project:proj_alpha", "project:proj_beta"]', () => {
          const scopes = ["project:proj_alpha", "project:proj_beta"];

          it("whoami echoes the assumed scopes", async () => {
            const result = await runWithIterateContext({
              scopes,
              fn: async ({ iterate }) => iterate.whoami(),
            });
            expect(result.scopes).toEqual(["project:proj_alpha", "project:proj_beta"]);
          });

          it("the current project is the first concrete scope", async () => {
            const current = await runWithIterateContext({
              scopes,
              fn: async ({ iterate }) => iterate.project.describe(),
            });
            expect(current).toEqual({ id: "proj_alpha" });
          });
        });

        describe('with scopes ["project:proj_alpha"]', () => {
          const scopes = ["project:proj_alpha"];

          it("projects.get(...).describe() pipelines", async () => {
            const described = await runWithIterateContext({
              scopes,
              fn: async ({ iterate }) => iterate.projects.get("proj_alpha").describe(),
            });
            expect(described).toEqual({ id: "proj_alpha" });
          });

          it("projects.get rejects a project outside the scope grant", async () => {
            await expect(
              runWithIterateContext({
                scopes,
                fn: async ({ iterate }) => iterate.projects.get("proj_forbidden").describe(),
              }),
            ).rejects.toThrow(/Not authorized for project: proj_forbidden/);
          });

          it("surfaces errors thrown by the snippet", async () => {
            await expect(
              runWithIterateContext({
                scopes,
                fn: async () => {
                  throw new Error("Snippet exploded");
                },
              }),
            ).rejects.toThrow("Snippet exploded");
          });

          it("surfaces errors thrown by iterate capabilities", async () => {
            await expect(
              runWithIterateContext({
                scopes,
                fn: async ({ iterate }) =>
                  iterate.testMethod({ behavior: "throw", message: "Bla bla" }),
              }),
            ).rejects.toThrow("Bla bla");
          });
        });

        describe('with scopes ["project:*"]', () => {
          const scopes = ["project:*"];

          it("projects.get authorizes any project", async () => {
            const result = await runWithIterateContext({
              scopes,
              fn: async ({ iterate }) => iterate.projects.get("proj_alpha").describe(),
            });
            expect(result).toEqual({ id: "proj_alpha" });
          });

          it("a wildcard-only scope names no single current project", async () => {
            await expect(
              runWithIterateContext({
                scopes,
                fn: async ({ iterate }) => {
                  const project = await iterate.project;
                  return await project.describe();
                },
              }),
            ).rejects.toThrow("No current project is available for these scopes.");
          });
        });

        describe("with a brand new project", () => {
          const slug = `${testRunSlugPrefix}-${uniqueSuffix()}`.slice(0, 40);
          const scopes = ["create_project"];
          let project: CreatedProject;

          beforeAll(async () => {
            project = await runWithIterateContext({
              scopes,
              vars: { slug },
              fn: async ({ iterate, vars }) => iterate.projects.create({ slug: vars.slug }),
            });
          });

          afterAll(async () => {
            if (!project || typeof project !== "object" || !("id" in project)) return;
            await runWithIterateContext({
              scopes: [`project:${project.id}`],
              vars: { id: project.id },
              fn: async ({ iterate, vars }) => iterate.projects.remove({ id: vars.id }),
            }).catch(() => undefined);
          });

          it("creates a real project", () => {
            expect(project).toMatchObject({
              slug,
            });
            expect(project.id).toMatch(/^proj_/);
            expect(project.ingressUrl).toContain(project.slug);
          });

          describe("with its project scope", () => {
            it("projects.list reflects the concrete scope", async () => {
              const list = await runWithIterateContext({
                scopes: [`project:${project.id}`],
                fn: async ({ iterate }) => iterate.projects.list(),
              });
              expect(list.projects).toMatchObject([{ id: project.id, slug: project.slug }]);
            });

            it("describes the project", async () => {
              const described = await runWithIterateContext({
                scopes: [`project:${project.id}`],
                vars: { project },
                fn: async ({ iterate, vars }) => iterate.projects.get(vars.project.id).describe(),
              });
              expect(described).toEqual({ id: project.id });
            });
          });
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
