import { Fragment, useMemo, useState } from "react";
import { Link, useMatches, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/events-contract";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";
import { Input } from "@iterate-com/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@iterate-com/ui/components/popover";
import { toast } from "@iterate-com/ui/components/sonner";
import { ChevronDownIcon } from "lucide-react";
import { StreamPathLabel } from "~/components/stream-path-label.tsx";
import { useStreamsChrome } from "~/components/streams-chrome.tsx";
import { useCurrentProjectSlug } from "~/hooks/use-current-project-slug.ts";
import { getAncestorStreamPaths } from "~/lib/stream-path-ancestors.ts";
import type { StreamRendererMode } from "~/lib/stream-feed-types.ts";
import { projectScopedQueryKey } from "~/lib/project-slug.ts";
import { streamPathToSplat } from "~/lib/stream-links.ts";
import { defaultStreamViewSearch } from "~/lib/stream-view-search.ts";
import { getOrpc } from "~/orpc/client.ts";

type BreadcrumbSearch = {
  projectSlug?: string;
  [key: string]: unknown;
};

const CHILD_STREAM_SEGMENT_PATTERN = /^[a-z0-9_-]+$/;

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
    composer:
      "composer" in search && typeof search.composer === "string"
        ? search.composer
        : defaultStreamViewSearch.composer,
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
        {selectedStreamPath != null ? (
          <StreamChildrenBreadcrumb parentPath={selectedStreamPath} streamSearch={streamSearch} />
        ) : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function StreamChildrenBreadcrumb({
  parentPath,
  streamSearch,
}: {
  parentPath: StreamPathType;
  streamSearch: ReturnType<typeof makeStreamSearch>;
}) {
  const navigate = useNavigate();
  const projectSlug = useCurrentProjectSlug();
  const orpc = getOrpc();
  const [open, setOpen] = useState(false);
  const [newChildSegment, setNewChildSegment] = useState("");

  const listChildrenOptions = useMemo(
    () => orpc.listChildren.queryOptions({ input: { path: parentPath } }),
    [orpc, parentPath],
  );
  const listChildrenQueryKey = useMemo(
    () => projectScopedQueryKey(listChildrenOptions.queryKey, projectSlug),
    [listChildrenOptions.queryKey, projectSlug],
  );

  const childrenQuery = useQuery({
    ...listChildrenOptions,
    queryKey: listChildrenQueryKey,
    staleTime: 5_000,
  });

  const children = useMemo(() => {
    if (!childrenQuery.data) return [];
    return childrenQuery.data.filter((child) => child.path !== parentPath);
  }, [childrenQuery.data, parentPath]);

  function navigateToChild(childPath: StreamPathType) {
    setOpen(false);
    void navigate({
      to: "/streams/$/",
      params: { _splat: streamPathToSplat(childPath) },
      search: streamSearch,
    });
  }

  function submitNewChild() {
    const trimmedSegment = newChildSegment.trim();
    if (trimmedSegment.length === 0) return;

    if (!CHILD_STREAM_SEGMENT_PATTERN.test(trimmedSegment)) {
      toast.error("Use lowercase letters, numbers, hyphens, or underscores only.");
      return;
    }

    const nextChildPath = StreamPath.safeParse(
      parentPath === "/" ? `/${trimmedSegment}` : `${parentPath}/${trimmedSegment}`,
    );
    if (!nextChildPath.success) {
      toast.error("Couldn't build that child stream path.");
      return;
    }

    setNewChildSegment("");
    navigateToChild(nextChildPath.data);
  }

  return (
    <>
      <BreadcrumbSeparator className="hidden xl:block opacity-30">/</BreadcrumbSeparator>
      <BreadcrumbItem className="hidden xl:inline-flex">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger className="flex items-center gap-1 text-sm text-muted-foreground opacity-40 transition-opacity hover:opacity-70 focus-visible:opacity-70">
            Children
            <ChevronDownIcon className="size-3" />
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={8} className="w-56 gap-0 p-0">
            <form
              className="border-b p-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                submitNewChild();
              }}
            >
              <Input
                value={newChildSegment}
                onChange={(event) => setNewChildSegment(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setOpen(false);
                  }
                }}
                placeholder="New child..."
                aria-label="New child stream name"
                className="h-7 border-transparent bg-transparent text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:ring-0"
              />
            </form>
            <div className="max-h-48 overflow-y-auto p-1">
              {children.length === 0 ? (
                <p className="px-2 py-1.5 text-center text-xs text-muted-foreground">
                  No children yet
                </p>
              ) : (
                children.map((child) => (
                  <button
                    key={child.path}
                    type="button"
                    className="flex w-full items-center rounded-md px-2 py-1.5 text-left font-mono text-xs outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                    onClick={() => navigateToChild(child.path)}
                  >
                    /{getStreamSegmentLabel(child.path)}
                  </button>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>
      </BreadcrumbItem>
    </>
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

  return (
    <Link
      to={crumb.to ?? "/"}
      search={(previous: BreadcrumbSearch) => ({ ...previous, projectSlug })}
    />
  );
}

function getStreamSegmentLabel(path: StreamPathType) {
  return path === "/" ? "/" : (path.split("/").at(-1) ?? path);
}

function makeStreamSearch({
  composer,
  projectSlug,
  renderer,
}: {
  composer: typeof defaultStreamViewSearch.composer;
  projectSlug: string;
  renderer: StreamRendererMode;
}) {
  return {
    event: defaultStreamViewSearch.event,
    composer,
    projectSlug,
    renderer,
  };
}
