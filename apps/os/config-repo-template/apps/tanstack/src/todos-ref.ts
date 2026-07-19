import type { DynamicWorkerSource, StatefulDynamicWorkerRef } from "iterate/sdk";

const repoFiles = { type: "repo", repoPath: "/repos/config" } as const;

/** TanStack Start pages and browser assets, built by the app's Vite pipeline. */
export const tanstackPageSource = {
  files: repoFiles,
  options: { pipeline: "vite", rootDir: "apps/tanstack" },
} satisfies DynamicWorkerSource;

/** The todo API's durable identity and deliberately small build. The stale
 * policy lets a still-running facet answer while the host checks for a newer
 * repo version in the background; a cold facet mounts this exact cached
 * artifact. */
export const tanstackTodosRef = {
  type: "stateful",
  path: "/",
  className: "TanstackTodos",
  durableWorkerKey: "app-tanstack",
  updatePolicy: "stale-while-rebuild",
  source: {
    files: repoFiles,
    options: {
      entryPoint: "src/todos-app.ts",
      minify: true,
      rootDir: "apps/tanstack",
    },
  },
} satisfies StatefulDynamicWorkerRef;
