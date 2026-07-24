import { expect, test } from "vitest";
import type { StatefulDynamicWorkerRef } from "iterate/sdk";
import { adminSecret, withItxSession } from "./test-helpers.ts";

test("the packaged Todo adopts rows from the config-owned worker", async () => {
  using session = withItxSession();
  using itx = session.authenticate({
    type: "admin-secret",
    secret: adminSecret(),
  });
  using project = await itx.projects
    .get(`todo-package-migration-${crypto.randomUUID().slice(0, 8)}`)
    .create({});

  const title = `created-before-packaging-${crypto.randomUUID().slice(0, 8)}`;
  {
    using configOwnedTodo = project.workers.get(configOwnedTodoRef()) as unknown as TodoWorker;
    await configOwnedTodo.add(title);
    expect(await configOwnedTodo.getTodos()).toMatchObject([{ done: false, title }]);
  }

  // Only the source changes. The class, scope, and durable worker key are the
  // state address that must remain stable across the package boundary.
  using packagedTodo = project.workers.get(packagedTodoRef) as unknown as TodoWorker;
  expect(await packagedTodo.getTodos()).toMatchObject([{ done: false, title }]);
});

type TodoWorker = Disposable & {
  add(title: string): Promise<void>;
  getTodos(): Promise<{ done: boolean; title: string }[]>;
};

const packagedTodoRef = {
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
} satisfies StatefulDynamicWorkerRef;

function configOwnedTodoRef(): StatefulDynamicWorkerRef {
  return {
    className: "TodoApp",
    durableWorkerKey: "app-todo-live",
    path: "/",
    source: {
      createWorker: {
        entryPoint: "worker.ts",
        files: {
          files: {
            "worker.ts": `
              import { DurableObject } from "cloudflare:workers";

              export class TodoApp extends DurableObject {
                constructor(ctx, env) {
                  super(ctx, env);
                  this.ctx.storage.sql.exec(\`
                    CREATE TABLE IF NOT EXISTS todos (
                      id TEXT PRIMARY KEY,
                      title TEXT NOT NULL,
                      done INTEGER NOT NULL DEFAULT 0,
                      created_at TEXT NOT NULL
                    )
                  \`);
                }

                add(title) {
                  this.ctx.storage.sql.exec(
                    "INSERT INTO todos (id, title, done, created_at) VALUES (?, ?, 0, ?)",
                    crypto.randomUUID(),
                    title,
                    new Date().toISOString(),
                  );
                }

                getTodos() {
                  return this.ctx.storage.sql
                    .exec("SELECT title, done FROM todos ORDER BY created_at, id")
                    .toArray()
                    .map((row) => ({ ...row, done: row.done !== 0 }));
                }
              }
            `,
          },
          type: "inline",
        },
      },
    },
    type: "stateful",
  };
}
