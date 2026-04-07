import { Fragment } from "react";
import { Link, useMatches, useSearch } from "@tanstack/react-router";
import type { StreamPath as StreamPathType } from "@iterate-com/events-contract";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";
import { StreamPathLabel } from "~/components/stream-path-label.tsx";
import { useStreamsChrome } from "~/components/streams-chrome.tsx";
import { useCurrentProjectSlug } from "~/hooks/use-current-project-slug.ts";
import { getAncestorStreamPaths } from "~/lib/stream-path-ancestors.ts";
import type { StreamRendererMode } from "~/lib/stream-feed-types.ts";
import { streamPathToSplat } from "~/lib/stream-links.ts";
import { defaultStreamViewSearch } from "~/lib/stream-view-search.ts";

export function PathBreadcrumbs() {
  const matches = useMatches();
  const { selectedStreamPath } = useStreamsChrome();
  const projectSlug = useCurrentProjectSlug();
  const search = useSearch({ strict: false });

  if (matches.some((match) => match.status === "pending")) {
    return null;
  }

  const crumbs = selectedStreamPath ? getStreamCrumbs(selectedStreamPath) : getRouteCrumbs(matches);
  const parentCrumbs = crumbs.slice(0, -1);
  const currentCrumb = crumbs.at(-1);
  const streamSearch = makeStreamSearch({
    projectSlug,
    renderer:
      "renderer" in search && typeof search.renderer === "string"
        ? search.renderer
        : defaultStreamViewSearch.renderer,
  });

  if (!currentCrumb) {
    return null;
  }

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {parentCrumbs.map((crumb) => (
          <Fragment key={crumb.key}>
            <BreadcrumbItem className="hidden md:inline-flex">
              <BreadcrumbLink render={renderBreadcrumbLink({ crumb, projectSlug, streamSearch })}>
                <BreadcrumbLabel crumb={crumb} />
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block">/</BreadcrumbSeparator>
          </Fragment>
        ))}

        {parentCrumbs.length > 0 ? (
          <>
            <BreadcrumbItem className="md:hidden">
              <BreadcrumbEllipsis className="size-auto" />
            </BreadcrumbItem>
            <BreadcrumbSeparator className="md:hidden">/</BreadcrumbSeparator>
          </>
        ) : null}

        <BreadcrumbItem>
          <BreadcrumbPage className="max-w-[16rem]">
            <BreadcrumbLabel crumb={currentCrumb} />
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function BreadcrumbLabel({ crumb }: { crumb: { label: string; path?: StreamPathType } }) {
  if (!crumb.path) {
    return <>{crumb.label}</>;
  }

  return <StreamPathLabel path={crumb.path} label={crumb.label} startChars={18} endChars={16} />;
}

function getRouteCrumbs(matches: ReturnType<typeof useMatches>) {
  return matches.flatMap((match) => {
    const label =
      (match.loaderData as { breadcrumb?: string } | undefined)?.breadcrumb ??
      (match.staticData as { breadcrumb?: string } | undefined)?.breadcrumb;

    if (!label) {
      return [];
    }

    return [{ key: match.id, label, to: match.pathname }];
  });
}

function getStreamCrumbs(path: StreamPathType) {
  return [
    { key: "streams", label: "Streams", to: "/streams/" },
    ...[...getAncestorStreamPaths(path), path]
      .filter((streamPath) => streamPath !== "/")
      .map((streamPath) => ({
        key: `stream:${streamPath}`,
        label: getStreamSegmentLabel(streamPath),
        path: streamPath,
      })),
  ];
}

function renderBreadcrumbLink({
  crumb,
  projectSlug,
  streamSearch,
}: {
  crumb: { path?: StreamPathType; to?: string };
  projectSlug: string;
  streamSearch: ReturnType<typeof makeStreamSearch>;
}) {
  if (crumb.path) {
    return (
      <Link
        to="/streams/$/"
        params={{ _splat: streamPathToSplat(crumb.path) }}
        search={streamSearch}
      />
    );
  }

  return <Link to={crumb.to ?? "/"} search={(previous) => ({ ...previous, projectSlug })} />;
}

function getStreamSegmentLabel(path: StreamPathType) {
  return path === "/" ? "/" : (path.split("/").at(-1) ?? path);
}

function makeStreamSearch({
  projectSlug,
  renderer,
}: {
  projectSlug: string;
  renderer: StreamRendererMode;
}) {
  return {
    event: defaultStreamViewSearch.event,
    projectSlug,
    renderer,
  };
}
