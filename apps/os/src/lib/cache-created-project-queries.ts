import type { QueryClient } from "@tanstack/react-query";
import type { Project } from "@iterate-com/os-contract";
import { projectsListQueryOptions } from "~/lib/project-route-query.ts";
import { orpc } from "~/orpc/client.ts";

type ProjectsListData = { projects: Project[]; total: number };

export function cacheCreatedProjectQueries(input: {
  project: Project & { ingressUrl: string };
  queryClient: QueryClient;
}) {
  const findQuery = orpc.projects.find.queryOptions({ input: { id: input.project.id } });
  const findBySlugQuery = orpc.projects.findBySlug.queryOptions({
    input: { slug: input.project.slug },
  });
  input.queryClient.setQueryData(findQuery.queryKey, input.project);
  input.queryClient.setQueryData(findBySlugQuery.queryKey, input.project);
  const listProject: Project = {
    id: input.project.id,
    slug: input.project.slug,
    customHostname: input.project.customHostname,
    createdAt: input.project.createdAt,
    updatedAt: input.project.updatedAt,
    isOrphanedProjectFromAuthService: input.project.isOrphanedProjectFromAuthService,
  };

  for (const listInput of [
    { limit: 20, offset: 0 },
    { limit: 100, offset: 0 },
  ] as const) {
    const listQuery = projectsListQueryOptions(listInput);
    input.queryClient.setQueryData<ProjectsListData>(listQuery.queryKey, (existing) => {
      if (!existing) return existing;
      if (existing.projects.some((project) => project.id === input.project.id)) {
        return {
          ...existing,
          projects: existing.projects.map((project) =>
            project.id === input.project.id ? listProject : project,
          ),
        };
      }

      return {
        ...existing,
        projects: [listProject, ...existing.projects].slice(0, listInput.limit),
        total: existing.total + 1,
      };
    });
  }
}
