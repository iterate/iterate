import { Fragment, useMemo, useState } from "react";
import { Link, useMatches, useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import type { StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";
import { EventsStreamPathLabel } from "@iterate-com/ui/components/events/stream-path-label";
import { Input } from "@iterate-com/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@iterate-com/ui/components/popover";
import { toast } from "@iterate-com/ui/components/sonner";
import { useProjectStreamsList } from "~/lib/itx-queries.ts";
import type {
  RouteBreadcrumbLoaderData,
  RouteBreadcrumbStaticData,
} from "~/lib/route-breadcrumbs.ts";
import { streamPathAncestors, streamPathChild, streamPathParent } from "~/lib/stream-links.ts";

const CHILD_STREAM_SEGMENT_PATTERN = /^[a-z0-9_-]+$/;

export function PathBreadcrumbs() {
  const matches = useMatches();

  if (matches.some((match) => match.status === "pending")) {
    return null;
  }

  const streamBreadcrumb = matches
    .map((match) => (match.loaderData as RouteBreadcrumbLoaderData | undefined)?.streamBreadcrumb)
    .filter((value): value is NonNullable<RouteBreadcrumbLoaderData["streamBreadcrumb"]> =>
      Boolean(value),
    )
    .at(-1);

  const routeCrumbs = matches.flatMap((match) => {
    const staticBreadcrumb = (match.staticData as RouteBreadcrumbStaticData | undefined)
      ?.breadcrumb;
    const dynamicBreadcrumb = (match.loaderData as RouteBreadcrumbLoaderData | undefined)
      ?.breadcrumb;
    const label = dynamicBreadcrumb ?? staticBreadcrumb;

    if (!label) {
      return [];
    }

    return [
      {
        id: match.id,
        label,
        to: match.pathname,
        streamPath: undefined,
      },
    ];
  });
  const crumbs = streamBreadcrumb
    ? [
        ...routeCrumbs.slice(0, -1),
        ...streamPathAncestors(streamBreadcrumb.streamPath).map((streamPath) => ({
          id: `stream:${streamPath}`,
          label: getStreamSegmentLabel(streamPath),
          to: undefined,
          streamPath,
        })),
      ]
    : routeCrumbs;

  if (crumbs.length === 0) {
    return null;
  }

  const lastCrumb = crumbs.at(-1);
  const parentCrumbs = crumbs.slice(0, -1);

  if (!lastCrumb) {
    return null;
  }

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {parentCrumbs.map((crumb) => (
          <Fragment key={crumb.id}>
            <BreadcrumbItem className="hidden md:inline-flex">
              {crumb.streamPath != null && crumb.streamPath !== "/" && streamBreadcrumb ? (
                <StreamSegmentNavigator
                  label={crumb.label}
                  segmentPath={crumb.streamPath}
                  streamBreadcrumb={streamBreadcrumb}
                />
              ) : (
                <BreadcrumbLink render={renderCrumbLink({ crumb, streamBreadcrumb })}>
                  <BreadcrumbLabel crumb={crumb} />
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
          </Fragment>
        ))}

        {parentCrumbs.length > 0 && (
          <>
            <BreadcrumbItem className="md:hidden">
              <BreadcrumbEllipsis className="size-auto" />
            </BreadcrumbItem>
            <BreadcrumbSeparator className="md:hidden" />
          </>
        )}

        <BreadcrumbItem>
          {lastCrumb.streamPath != null && lastCrumb.streamPath !== "/" && streamBreadcrumb ? (
            <BreadcrumbPage className="max-w-[16rem]">
              <StreamSegmentNavigator
                isCurrent
                label={lastCrumb.label}
                segmentPath={lastCrumb.streamPath}
                streamBreadcrumb={streamBreadcrumb}
              />
            </BreadcrumbPage>
          ) : (
            <BreadcrumbPage className="max-w-[16rem] truncate">
              <BreadcrumbLabel crumb={lastCrumb} />
            </BreadcrumbPage>
          )}
        </BreadcrumbItem>
        {streamBreadcrumb ? <StreamChildrenBreadcrumb streamBreadcrumb={streamBreadcrumb} /> : null}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function BreadcrumbLabel({ crumb }: { crumb: { label: string; streamPath?: StreamPathType } }) {
  if (!crumb.streamPath) return <>{crumb.label}</>;
  return <EventsStreamPathLabel path={crumb.streamPath} label={crumb.label} />;
}

function renderCrumbLink({
  crumb,
  streamBreadcrumb,
}: {
  crumb: { streamPath?: StreamPathType; to?: string };
  streamBreadcrumb: RouteBreadcrumbLoaderData["streamBreadcrumb"];
}) {
  if (crumb.streamPath && streamBreadcrumb) {
    return (
      <Link
        to="/projects/$projectSlug/streams/$"
        params={{
          projectSlug: streamBreadcrumb.projectSlug,
          _splat: crumb.streamPath,
        }}
      />
    );
  }

  return <Link to={crumb.to ?? "/"} />;
}

/**
 * Breadcrumb segment for one level of a stream path. Opens a popover listing
 * the sibling streams at that depth, so any segment can be swapped without
 * walking back up through the streams index.
 */
function StreamSegmentNavigator({
  isCurrent = false,
  label,
  segmentPath,
  streamBreadcrumb,
}: {
  isCurrent?: boolean;
  label: string;
  segmentPath: StreamPathType;
  streamBreadcrumb: NonNullable<RouteBreadcrumbLoaderData["streamBreadcrumb"]>;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const streamsQuery = useProjectStreamsList(streamBreadcrumb.projectId);
  const siblingPaths = useMemo(() => {
    const parentPath = streamPathParent(segmentPath);
    const paths = (streamsQuery.data ?? [])
      .map((stream) => stream.streamPath)
      .filter((path) => isImmediateChild({ childPath: path, parentPath }));
    if (!paths.includes(segmentPath)) paths.push(segmentPath);
    return paths.toSorted((left, right) => left.localeCompare(right));
  }, [segmentPath, streamsQuery.data]);

  function navigateToSibling(path: StreamPathType) {
    setOpen(false);
    if (path === segmentPath && isCurrent) return;
    void navigate({
      to: "/projects/$projectSlug/streams/$",
      params: {
        projectSlug: streamBreadcrumb.projectSlug,
        _splat: path,
      },
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={`flex min-w-0 items-center gap-0.5 rounded-sm font-mono text-sm transition-colors ${
          isCurrent ? "text-foreground" : "text-muted-foreground hover:text-foreground"
        }`}
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-64 gap-0 p-0">
        <div className="max-h-64 overflow-y-auto p-1">
          {siblingPaths.map((path) => (
            <button
              key={path}
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left font-mono text-xs outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
              onClick={() => navigateToSibling(path)}
            >
              <span className="min-w-0 truncate">/{getStreamSegmentLabel(path)}</span>
              {path === segmentPath ? (
                <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
              ) : null}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function StreamChildrenBreadcrumb({
  streamBreadcrumb,
}: {
  streamBreadcrumb: NonNullable<RouteBreadcrumbLoaderData["streamBreadcrumb"]>;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [newChildSegment, setNewChildSegment] = useState("");
  const streamsQuery = useProjectStreamsList(streamBreadcrumb.projectId);
  const children = useMemo(
    () =>
      (streamsQuery.data ?? []).filter((stream) =>
        isImmediateChild({
          childPath: stream.streamPath,
          parentPath: streamBreadcrumb.streamPath,
        }),
      ),
    [streamsQuery.data, streamBreadcrumb.streamPath],
  );

  function navigateToChild(childPath: StreamPathType) {
    setOpen(false);
    void navigate({
      to: "/projects/$projectSlug/streams/$",
      params: {
        projectSlug: streamBreadcrumb.projectSlug,
        _splat: childPath,
      },
    });
  }

  function submitNewChild() {
    const trimmedSegment = newChildSegment.trim();
    if (trimmedSegment.length === 0) return;

    if (!CHILD_STREAM_SEGMENT_PATTERN.test(trimmedSegment)) {
      toast.error("Use lowercase letters, numbers, hyphens, or underscores only.");
      return;
    }

    try {
      const nextChildPath = streamPathChild({
        parent: streamBreadcrumb.streamPath,
        childSegment: trimmedSegment,
      });
      setNewChildSegment("");
      navigateToChild(nextChildPath);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build child stream path.");
    }
  }

  return (
    <>
      <BreadcrumbSeparator className="hidden xl:block opacity-30" />
      <BreadcrumbItem className="hidden xl:inline-flex">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger className="flex items-center gap-1 text-sm text-muted-foreground opacity-50 transition-opacity hover:opacity-80 focus-visible:opacity-80">
            Children
            <span aria-hidden="true">v</span>
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
                    key={child.name}
                    type="button"
                    className="flex w-full items-center rounded-md px-2 py-1.5 text-left font-mono text-xs outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                    onClick={() => navigateToChild(child.streamPath)}
                  >
                    /{getStreamSegmentLabel(child.streamPath)}
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

function getStreamSegmentLabel(path: StreamPathType) {
  return path === "/" ? "/" : (path.split("/").at(-1) ?? path);
}

function isImmediateChild(input: { parentPath: StreamPathType; childPath: StreamPathType }) {
  if (input.childPath === input.parentPath) return false;
  if (input.parentPath === "/") {
    return input.childPath.split("/").filter(Boolean).length === 1;
  }

  const prefix = `${input.parentPath}/`;
  if (!input.childPath.startsWith(prefix)) return false;
  return input.childPath.slice(prefix.length).split("/").filter(Boolean).length === 1;
}
