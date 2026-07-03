import type { StreamPath } from "~/lib/stream-links.ts";

export type RouteBreadcrumbStaticData = {
  breadcrumb?: string;
};

export type RouteBreadcrumbLoaderData = {
  breadcrumb?: string;
  /**
   * The stream this page is a view of. Every project-scoped page publishes
   * one (every domain object IS a stream); it drives the stream-aware path
   * breadcrumbs in the shell header and gives the ⌘K switcher its project +
   * current-path context.
   */
  streamBreadcrumb?: {
    projectId: string;
    projectSlug: string;
    streamPath: StreamPath;
  };
};

export function breadcrumbStaticData(breadcrumb: string): RouteBreadcrumbStaticData {
  return { breadcrumb };
}

export function breadcrumbLoaderData<T extends RouteBreadcrumbLoaderData>(data: T): T {
  return data;
}
