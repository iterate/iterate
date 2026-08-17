// The NotesApp worker ref as a dependency-free literal: the mobile app (a
// plain-node tsconfig with no Cloudflare lib types) needs the ref without
// pulling in sdk.ts. app-ref.ts re-exports this with the satisfies check
// that keeps it honest against StatefulDynamicWorkerRef.
//
// Convergence model (tasks/mobile-notes.md, grill session 2): notes are
// markdown files in the dedicated notes REPO, written through the notes
// WORKSPACE; note facts ride the workspace's own stream path.
export const notesWorkspacePath = "/workspaces/notes";
export const notesRepoPath = "/repos/notes";

export const notesWorkerRef = {
  className: "NotesApp",
  durableWorkerKey: "app-notes-stream",
  path: "/",
  source: {
    createWorker: {
      entryPoint: "node_modules/iterate/dist/starter-apps/notes/configured-worker.mjs",
      files: {
        include: ["package.json"],
        repoPath: "/repos/config",
        type: "repo" as const,
      },
    },
  },
  type: "stateful" as const,
};
