import type { StreamPath } from "@iterate-com/shared/streams/types";

export type RouteBreadcrumbStaticData = {
  breadcrumb?: string;
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
