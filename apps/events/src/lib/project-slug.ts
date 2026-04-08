import { ProjectSlug, type ProjectSlug as ProjectSlugValue } from "@iterate-com/events-contract";
import { z } from "zod";

export const iterateProjectHeader = "x-iterate-project";
export const projectSlugSearchParam = "projectSlug";
export const defaultProjectSlug: ProjectSlugValue = "public";

export function normalizeProjectSlug(value: unknown): ProjectSlugValue {
  const result = ProjectSlug.safeParse(value);
  return result.success ? result.data : defaultProjectSlug;
}

export function resolveProjectSlug(args: {
  url?: string | URL;
  headerValue?: string | null;
}): ProjectSlugValue {
  const searchParamValue =
    args.url == null ? undefined : new URL(args.url).searchParams.get(projectSlugSearchParam);
  const parsedSearchParam = ProjectSlug.safeParse(searchParamValue);

  if (parsedSearchParam.success) {
    return parsedSearchParam.data;
  }

  const parsedHeader = ProjectSlug.safeParse(args.headerValue);
  if (parsedHeader.success) {
    return parsedHeader.data;
  }

  return defaultProjectSlug;
}

export function projectScopedQueryKey(baseKey: readonly unknown[], projectSlug: ProjectSlugValue) {
  return [...baseKey, { projectSlug }] as const;
}

const AppSearch = z.object({
  projectSlug: z.string().optional(),
});

export function validateAppSearch(search: unknown) {
  const result = AppSearch.safeParse(search);

  return {
    projectSlug: normalizeProjectSlug(result.success ? result.data.projectSlug : undefined),
  };
}
