import type { StreamPath } from "@iterate-com/shared/streams/types";

export type RouteBreadcrumbStaticData = {
  breadcrumb?: string;
  /**
   * Hides the app shell's breadcrumbs header row. Stream pages set this —
   * the ⌘K path pill in the stream header replaces breadcrumbs there, and
   * the stream view renders its own SidebarTrigger.
   */
  hideAppHeader?: boolean;
};

export type RouteBreadcrumbLoaderData = {
  breadcrumb?: string;
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
