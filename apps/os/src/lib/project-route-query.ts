import type { QueryClient } from "@tanstack/react-query";
import { orpc } from "~/orpc/client.ts";

export const PROJECT_ROUTE_STALE_TIME = 30_000;
export const PROJECT_CHILD_ROUTE_STALE_TIME = 10_000;
export const PROJECT_AGENT_RUNTIME_STALE_TIME = 5_000;
export const PROJECT_LIFECYCLE_STALE_TIME = 1_000;

export function projectBySlugQueryOptions(projectSlug: string) {
  return {
    ...orpc.projects.findBySlug.queryOptions({ input: { slug: projectSlug } }),
    staleTime: PROJECT_ROUTE_STALE_TIME,
  };
}

export function ensureProjectBySlug(input: { queryClient: QueryClient; projectSlug: string }) {
  return input.queryClient.ensureQueryData(projectBySlugQueryOptions(input.projectSlug));
}

export function projectsListQueryOptions(input: { limit: number; offset: number }) {
  return {
    ...orpc.projects.list.queryOptions({ input }),
    staleTime: PROJECT_ROUTE_STALE_TIME,
  };
}

export function projectLifecycleStateQueryOptions(projectId: string) {
  return {
    ...orpc.project.lifecycleState.queryOptions({ input: { projectSlugOrId: projectId } }),
    staleTime: PROJECT_LIFECYCLE_STALE_TIME,
  };
}

export function projectAgentPresetsQueryOptions(projectId: string) {
  return {
    ...orpc.project.agents.listPresets.queryOptions({ input: { projectSlugOrId: projectId } }),
    staleTime: PROJECT_CHILD_ROUTE_STALE_TIME,
  };
}

export function projectAgentRuntimeStateQueryOptions(input: {
  agentPath: string;
  projectId: string;
}) {
  return {
    ...orpc.project.agents.runtimeState.queryOptions({
      input: { agentPath: input.agentPath, projectSlugOrId: input.projectId },
    }),
    staleTime: PROJECT_AGENT_RUNTIME_STALE_TIME,
  };
}

export function projectInboundMcpSessionsQueryOptions(projectId: string) {
  return {
    ...orpc.project.inboundMcpServer.listSessions.queryOptions({
      input: { projectSlugOrId: projectId },
    }),
    staleTime: PROJECT_CHILD_ROUTE_STALE_TIME,
  };
}

export function projectReposListQueryOptions(projectId: string) {
  return {
    ...orpc.project.repos.list.queryOptions({ input: { projectSlugOrId: projectId } }),
    staleTime: PROJECT_CHILD_ROUTE_STALE_TIME,
  };
}

export function projectRepoQueryOptions(input: { projectId: string; repoSlug: string }) {
  return {
    ...orpc.project.repos.get.queryOptions({
      input: { projectSlugOrId: input.projectId, repoSlug: input.repoSlug },
    }),
    staleTime: PROJECT_CHILD_ROUTE_STALE_TIME,
  };
}

export function projectSecretsListQueryOptions(projectId: string) {
  return {
    ...orpc.project.secrets.list.queryOptions({ input: { projectSlugOrId: projectId } }),
    staleTime: PROJECT_CHILD_ROUTE_STALE_TIME,
  };
}

export function projectSecretQueryOptions(input: { projectId: string; secretId: string }) {
  return {
    ...orpc.project.secrets.get.queryOptions({
      input: { id: input.secretId, projectSlugOrId: input.projectId },
    }),
    staleTime: PROJECT_CHILD_ROUTE_STALE_TIME,
  };
}

export function projectSlackConnectionQueryOptions(projectId: string) {
  return orpc.project.integrations.getSlackConnection.queryOptions({
    input: { projectSlugOrId: projectId },
  });
}

export function projectGoogleConnectionQueryOptions(projectId: string) {
  return orpc.project.integrations.getGoogleConnection.queryOptions({
    input: { projectSlugOrId: projectId },
  });
}

export function projectCustomHostnameStatusQueryOptions(projectId: string) {
  return {
    ...orpc.projects.customHostnameStatus.queryOptions({ input: { id: projectId } }),
    staleTime: PROJECT_CHILD_ROUTE_STALE_TIME,
  };
}
