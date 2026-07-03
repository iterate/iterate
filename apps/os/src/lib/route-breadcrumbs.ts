import { StreamPath } from "~/lib/stream-links.ts";

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
  streamBreadcrumb?: StreamBreadcrumb;
};

export type StreamBreadcrumb = {
  projectId: string;
  projectSlug: string;
  streamPath: StreamPath;
};

export function breadcrumbStaticData(breadcrumb: string): RouteBreadcrumbStaticData {
  return { breadcrumb };
}

export function breadcrumbLoaderData<T extends RouteBreadcrumbLoaderData>(data: T): T {
  return data;
}

/** The streamBreadcrumb triple every project-scoped loader publishes. */
export function streamBreadcrumb(
  project: { id: string; slug: string },
  streamPath: string,
): StreamBreadcrumb {
  return {
    projectId: project.id,
    projectSlug: project.slug,
    streamPath: StreamPath.parse(streamPath),
  };
}

/**
 * The deepest streamBreadcrumb across the current route matches — the stream
 * context of the page being viewed. Shared by the shell breadcrumbs and the
 * ⌘K switcher.
 */
export function activeStreamBreadcrumb(
  matches: ReadonlyArray<{ loaderData?: unknown }>,
): StreamBreadcrumb | undefined {
  return matches
    .map((match) => (match.loaderData as RouteBreadcrumbLoaderData | undefined)?.streamBreadcrumb)
    .filter((value): value is StreamBreadcrumb => Boolean(value))
    .at(-1);
}
