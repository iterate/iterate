import type { ItxCapabilityHost } from "../itx/types.ts";
import type { AgentCollection } from "../agents/types.ts";
import type { Repo, RepoCollection } from "../repos/types.ts";
import type { StreamCollection, StreamEvent } from "../streams/types.ts";
import type { WorkerCollection } from "../workers/types.ts";

export interface Project extends ItxCapabilityHost {
  streams: StreamCollection;
  describe(): Promise<{ projectId: string; name: string }>;
  agents: AgentCollection;
  repos: RepoCollection;
  repo: Repo;
  worker: ProjectWorker;
  workers: WorkerCollection;
}

export interface ProjectCollection {
  get(projectId: string): Project;
  create(args: { projectId?: string; slug: string }): Promise<Project>;
  list(): string[];
}

export interface ProjectWorker {
  fetch(req: Request): Promise<Response>;
  processEvent(input: { event: StreamEvent }): Promise<void>;
}
