// The MediaApp worker ref as a dependency-free literal: the mobile e2e (a
// plain-node tsconfig with no Cloudflare lib types) needs the ref without
// pulling in sdk.ts. app-ref.ts re-exports this with the satisfies check
// that keeps it honest against StatefulDynamicWorkerRef.
export const mediaStreamPath = "/media";

export const mediaWorkerRef = {
  className: "MediaApp",
  durableWorkerKey: "app-media-stream",
  path: "/",
  source: {
    createWorker: {
      entryPoint: "node_modules/iterate/dist/starter-apps/media/configured-worker.mjs",
      files: {
        include: ["package.json"],
        repoPath: "/repos/config",
        type: "repo" as const,
      },
    },
  },
  type: "stateful" as const,
};
