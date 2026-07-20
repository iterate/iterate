import type { DynamicWorkerSource, StatefulDynamicWorkerRef } from "iterate/sdk";

const repoFiles = { type: "repo", repoPath: "/repos/config" } as const;

/** SPA shell + client bundle (createApp). No SSR — server.ts is HTML only. */
export const todosPageSource = {
  files: repoFiles,
  options: {
    client: "src/client.tsx",
    entryPoint: "src/server.ts",
    minify: true,
    rootDir: "apps/todos",
  },
} satisfies DynamicWorkerSource;

/** The todo API's durable identity and deliberately small build. The stale
 * policy lets a still-running facet answer while the host checks for a newer
 * repo version in the background; a cold facet mounts this exact cached
 * artifact. */
export const todosAppRef = {
  type: "stateful",
  path: "/",
  className: "TodosApp",
  durableWorkerKey: "app-todos",
  updatePolicy: "stale-while-rebuild",
  source: {
    files: repoFiles,
    options: {
      entryPoint: "src/todos-app.ts",
      minify: true,
      rootDir: "apps/todos",
    },
  },
} satisfies StatefulDynamicWorkerRef;
