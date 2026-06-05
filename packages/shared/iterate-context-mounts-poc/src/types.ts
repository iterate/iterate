export type ProjectScopes = {
  projects: "all" | string[];
};

export type CapabilityTarget = "project" | "streams" | "repos" | "workspaces";

export type MountTarget = { worker: string; exportName: string } | { capability: CapabilityTarget };

export type MountMode = "object" | "function" | "path-dispatch";

export type MountSpec = {
  name: string;
  path: string[];
  target: MountTarget;
  mode?: MountMode;
};

export type WorkerSpec = {
  source: string;
};

export type IterateContextProps = {
  scopes: ProjectScopes;
  projectId?: string;
  workers?: Record<string, WorkerSpec>;
  mounts?: MountSpec[];
};

export type PathDispatchInput = {
  path: string[];
  args: unknown[];
  input?: unknown;
};
