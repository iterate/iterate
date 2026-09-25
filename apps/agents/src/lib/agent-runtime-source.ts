/** The agents runtime as `installAgents` takes it: configs/with-agents/agents' files by name, the
 *  same files the with-agents template's worker installs from the project's repo. */
export const agentRuntimeSource: Record<string, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../../../configs/with-agents/agents/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([path, text]) => [path.slice(path.lastIndexOf("/") + 1), text]),
);
