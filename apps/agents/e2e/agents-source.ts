// e2e/agents-source.ts — @iterate-com/agents as this checkout has it: the package's source files by
// name, `index.ts` their entry, a source the loader runs as written. The rows that drive the agents
// themselves install this, so they need neither a publish nor esm.sh; template.e2e.test.ts proves
// the published package installs from a config repo.
export const agentsWorkspaceSource: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>(["../../../packages/agents/src/*.ts", "!**/*.test.ts"], {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text]),
);
