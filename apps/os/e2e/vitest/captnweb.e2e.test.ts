import { describe, expect, it } from "vitest";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import WebSocket from "ws";
import { Redacted } from "@iterate-com/shared/apps/config";
import { requireAdminBearerToken, requireBaseUrl } from "../test-support/os-client.ts";
import type { IterateCapability } from "~/capnweb-playground.ts";

const baseUrl = requireBaseUrl();

// We want to prove that the same codemode snippet can be executed from both
// 1) inside a dynamic worker that is passed the iterate capability as RpcTarget
// 2) from within this vitest runner after creating a capnweb capability
// 3) (later) from a workers for platform deployment
const runWithIterateContexts = [
  {
    name: "over the websocket endpoint",
    async runWithIterateContext<Result>(input: RunWithIterateContextInput<Result>) {
      using iterate = withIterateFromNode({
        baseUrl,
        auth: adminAuth({ scopes: input.scopes }),
      });
      return await input.fn(iterate);
    },
  },
  {
    name: "inside /run dynamic worker",
    async runWithIterateContext<Result>(input: RunWithIterateContextInput<Result>) {
      const response = await fetch(new URL("/api/captnweb/run", baseUrl), {
        method: "POST",
        headers: {
          ...adminAuthHeaders(adminAuth({ scopes: input.scopes })),
          "content-type": "application/json",
        },
        body: JSON.stringify({ code: stringifySnippet(input.fn) }),
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
  describe("with admin auth", () => {
    for (const { name, runWithIterateContext } of runWithIterateContexts) {
      describe(name, () => {
        describe('with scopes ["project:proj_alpha", "project:proj_beta"]', () => {
          const scopes = ["project:proj_alpha", "project:proj_beta"];

          it("whoami echoes the assumed scopes", async () => {
            const result = await runWithIterateContext({
              scopes,
              fn: async (iterate) => iterate.whoami(),
            });
            expect(result.scopes).toEqual(["project:proj_alpha", "project:proj_beta"]);
          });

          it("projects.list reflects the concrete scopes", async () => {
            const list = await runWithIterateContext({
              scopes,
              fn: async (iterate) => iterate.projects.list(),
            });
            expect(list).toEqual(["proj_alpha", "proj_beta"]);
          });

          it("the current project is the first concrete scope", async () => {
            const current = await runWithIterateContext({
              scopes,
              fn: async (iterate) => {
                const project = await iterate.project;
                return project ? await project.describe() : undefined;
              },
            });
            expect(current).toEqual({ id: "proj_alpha" });
          });
        });

        describe('with scopes ["project:proj_alpha"]', () => {
          const scopes = ["project:proj_alpha"];

          it("projects.get(...).describe() pipelines", async () => {
            const described = await runWithIterateContext({
              scopes,
              fn: async (iterate) => iterate.projects.get("proj_alpha").describe(),
            });
            expect(described).toEqual({ id: "proj_alpha" });
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
                fn: async (iterate) =>
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
              fn: async (iterate) => iterate.projects.get("proj_alpha").describe(),
            });
            expect(result).toEqual({ id: "proj_alpha" });
          });
        });
      });
    }

    describe("over the websocket endpoint", () => {
      describe('with scopes ["project:proj_alpha"]', () => {
        const scopes = ["project:proj_alpha"];

        it("projects.get rejects a project outside the scope grant", async () => {
          using iterate = withIterateFromNode({ baseUrl, auth: adminAuth({ scopes }) });
          await expect(iterate.projects.get("proj_forbidden").describe()).rejects.toThrow(
            /Not authorized for project: proj_forbidden/,
          );
        });
      });

      describe('with scopes ["project:*"]', () => {
        const scopes = ["project:*"];

        it("a wildcard-only scope names no single current project", async () => {
          using iterate = withIterateFromNode({ baseUrl, auth: adminAuth({ scopes }) });
          const current = await iterate.project;
          expect(current).toBeUndefined();
        });
      });
    });

    describe("inside /run dynamic worker", () => {
      describe('with scopes ["project:proj_alpha"]', () => {
        it("the default snippet pipelines through a loaded worker", async () => {
          const response = await fetch(new URL("/api/captnweb/run", baseUrl), {
            headers: adminAuthHeaders(adminAuth({ scopes: ["project:proj_alpha"] })),
          });
          expect(response.ok).toBe(true);
          expect(await response.json()).toEqual({ id: "proj_alpha" });
        });
      });
    });
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

type CaptnwebSnippet<Result> = (iterate: RpcStub<IterateCapability>) => Promise<Result>;

type RunWithIterateContextInput<Result> = {
  scopes: string[];
  fn: CaptnwebSnippet<Result>;
};

function stringifySnippet<Result>(fn: CaptnwebSnippet<Result>) {
  const code = fn.toString();
  return code.startsWith("async ") ? code : `async ${code}`;
}
