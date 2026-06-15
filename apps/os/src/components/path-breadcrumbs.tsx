import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useMatches, useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { StreamState, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
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
import { connectItx } from "~/itx/itx-react.tsx";
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

  const activeProjectSlug = matches
    .map((match) => match.params)
    .map((params) =>
      typeof params === "object" && params && "projectSlug" in params
        ? params.projectSlug
        : undefined,
    )
    .filter((projectSlug): projectSlug is string => typeof projectSlug === "string")
    .at(-1);
  const isProjectScoped = activeProjectSlug != null;
  const breadcrumbMatches = isProjectScoped
    ? matches.filter((match) => !isProjectCollectionOrLayoutMatch(match))
    : matches;

  const routeCrumbs = breadcrumbMatches.flatMap((match) => {
    const staticBreadcrumb = (match.staticData as RouteBreadcrumbStaticData | undefined)
      ?.breadcrumb;
    const dynamicBreadcrumb = (match.loaderData as RouteBreadcrumbLoaderData | undefined)
      ?.breadcrumb;
    const label = dynamicBreadcrumb ?? staticBreadcrumb;

    if (!label) {
      return [];
    }

    if (
      isProjectScoped &&
      isProjectCollectionOrLayoutBreadcrumb({
        activeProjectSlug,
        label,
        pathname: match.pathname,
      })
    ) {
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

function isProjectCollectionOrLayoutMatch(match: ReturnType<typeof useMatches>[number]) {
  return (
    match.id === "/_app/projects" ||
    match.id === "/_app/projects/" ||
    match.id === "/_app/projects/$projectSlug" ||
    match.id === "/_app/projects/$projectSlug/"
  );
}

function isProjectCollectionOrLayoutBreadcrumb(input: {
  activeProjectSlug: string | undefined;
  label: string;
  pathname: string;
}) {
  const normalizedPathname = input.pathname.replace(/\/+$/, "");
  return (
    input.label === "Projects" ||
    (input.activeProjectSlug != null && input.label === input.activeProjectSlug) ||
    normalizedPathname === "/projects" ||
    (input.activeProjectSlug != null &&
      normalizedPathname === `/projects/${input.activeProjectSlug}`)
  );
}

/**
 * The child paths of one stream, fetched into local state while `enabled`
 * (popover open). One getState round trip over the project's itx socket per
 * open — no query cache, no subscription; the popover is short-lived and
 * reopening refetches. PathBreadcrumbs renders in the GLOBAL app chrome
 * (`_app.tsx`), NOT under the project provider, and itx here is deliberately
 * OPTIONAL: a slow or down socket may only degrade this navigator, never
 * suspend or blank the chrome. So we dial LAZILY and non-suspending via
 * `connectItx` inside the effect (gated by `enabled`) rather than the
 * suspending `useItx` hook — addressing the project by SLUG so we share the
 * same pooled socket the project page already warmed (the provider keys on
 * slug), instead of opening a second socket for the same project.
 */
function useStreamChildPaths(input: {
  enabled: boolean;
  projectSlug: string;
  streamPath: StreamPathType;
}): StreamPathType[] | undefined {
  const [childPaths, setChildPaths] = useState<StreamPathType[]>();
  const { enabled, projectSlug, streamPath } = input;

  useEffect(() => {
    // Reset on every input change INCLUDING close: a reopened popover (or a
    // navigation to another stream) must show "Loading…", never the previous
    // stream's siblings/children.
    setChildPaths(undefined);
    if (!enabled) return;
    let cancelled = false;
    void connectItx({ projectId: projectSlug })
      .then(async (itx) => await itx.streams.get(streamPath).getState())
      .then((state) => {
        if (!cancelled) setChildPaths([...StreamState.parse(state).childPaths]);
      })
      .catch(() => {
        // Navigation chrome: a failed lookup just means no siblings to offer.
        if (!cancelled) setChildPaths([]);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, projectSlug, streamPath]);

  return childPaths;
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
  const parentPath = streamPathParent(segmentPath);
  const fetchedSiblings = useStreamChildPaths({
    enabled: open,
    projectSlug: streamBreadcrumb.projectSlug,
    streamPath: parentPath,
  });
  const siblingPaths = useMemo(() => {
    const paths = [...(fetchedSiblings ?? [])];
    if (!paths.includes(segmentPath)) paths.push(segmentPath);
    return paths.toSorted((left, right) => left.localeCompare(right));
  }, [fetchedSiblings, segmentPath]);

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
  const fetchedChildren = useStreamChildPaths({
    enabled: open,
    projectSlug: streamBreadcrumb.projectSlug,
    streamPath: streamBreadcrumb.streamPath,
  });
  const children = useMemo(
    () => [...(fetchedChildren ?? [])].toSorted((left, right) => left.localeCompare(right)),
    [fetchedChildren],
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
              {fetchedChildren === undefined ? (
                <p className="px-2 py-1.5 text-center text-xs text-muted-foreground">Loading...</p>
              ) : children.length === 0 ? (
                <p className="px-2 py-1.5 text-center text-xs text-muted-foreground">
                  No children yet
                </p>
              ) : (
                children.map((childPath) => (
                  <button
                    key={childPath}
                    type="button"
                    className="flex w-full items-center rounded-md px-2 py-1.5 text-left font-mono text-xs outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                    onClick={() => navigateToChild(childPath)}
                  >
                    /{getStreamSegmentLabel(childPath)}
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
