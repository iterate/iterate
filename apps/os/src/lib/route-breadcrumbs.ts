import type { StreamPath } from "~/lib/stream-links.ts";

export type RouteBreadcrumbStaticData = {
  breadcrumb?: string;
  /**
   * Hides the app shell's breadcrumbs header row. Stream pages set this —
   * the ⌘K path pill in the stream header replaces breadcrumbs there, and
   * the stream view renders its own SidebarTrigger.
   */
  hideAppHeader?: boolean;
};

export type RouteCommandPaletteStaticData = {
  commandPalette?: {
    stream?: {
      mode: "stream" | "agent";
      rootPath?: StreamPath;
    };
  };
};

export type AppRouteStaticData = RouteBreadcrumbStaticData & RouteCommandPaletteStaticData;

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
