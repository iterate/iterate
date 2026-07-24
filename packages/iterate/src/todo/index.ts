import type { ItxBinding } from "../sdk.ts";

const todoWorkerRef = {
  className: "TodoApp",
  durableWorkerKey: "app-todo-live",
  path: "/",
  source: {
    createWorker: {
      entryPoint: "node_modules/iterate/dist/todo/configured-worker.mjs",
      files: {
        include: ["package.json"],
        repoPath: "/repos/config",
        type: "repo",
      },
    },
  },
  type: "stateful",
} as const;

export const TodoApp = {
  create(env: { ITX: Pick<ItxBinding, "fetch"> }) {
    return {
      async fetch(request: Request): Promise<Response> {
        const headers = new Headers(request.headers);
        headers.set(
          "x-iterate-worker-dispatch",
          JSON.stringify({ buildBudgetMs: 15_000, ref: todoWorkerRef }),
        );
        return await env.ITX.fetch(new Request(request, { headers }));
      },
    };
  },
};
