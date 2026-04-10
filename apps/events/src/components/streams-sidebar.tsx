import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/events-contract";
import { Badge } from "@iterate-com/ui/components/badge";
import { Button } from "@iterate-com/ui/components/button";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@iterate-com/ui/components/sidebar";
import { toast } from "@iterate-com/ui/components/sonner";
import { Minus, Plus } from "lucide-react";
import { StreamPathLabel } from "~/components/stream-path-label.tsx";
import { useStreamsChrome } from "~/components/streams-chrome.tsx";
import { useCurrentProjectSlug } from "~/hooks/use-current-project-slug.ts";
import { useLiveStreamEvents } from "~/hooks/use-live-stream-events.ts";
import {
  discoverStreamPaths,
  filterStreamPaths,
  getStreamsSidebarState,
  type StreamsSidebarTreeNode,
} from "~/lib/streams-sidebar-tree.ts";
import { type StreamRendererMode } from "~/lib/stream-feed-types.ts";
import { streamPathToSplat } from "~/lib/stream-links.ts";
import { defaultStreamViewSearch } from "~/lib/stream-view-search.ts";

type StreamLinkSearch = {
  composer?: string;
  event?: number;
  projectSlug?: string;
  renderer?: string;
  [key: string]: unknown;
};

export function StreamsSidebar() {
  const navigate = useNavigate();
  const { selectedStreamPath } = useStreamsChrome();
  const projectSlug = useCurrentProjectSlug();
  const search = useSearch({ strict: false });
  const [searchValue, setSearchValue] = useState("");
  const [isCreatingStream, setIsCreatingStream] = useState(false);
  const [newStreamPathInput, setNewStreamPathInput] = useState("");
  const currentRenderer =
    "renderer" in search && typeof search.renderer === "string"
      ? (search.renderer as StreamRendererMode)
      : defaultStreamViewSearch.renderer;
  const currentComposer =
    "composer" in search && typeof search.composer === "string"
      ? search.composer
      : defaultStreamViewSearch.composer;
  const { events: rootEvents, isConnecting } = useLiveStreamEvents({
    streamPath: "/",
    projectSlug,
  });
  const streamSearch = useMemo(
    () => makeStreamSearch({ projectSlug, renderer: currentRenderer, composer: currentComposer }),
    [currentComposer, currentRenderer, projectSlug],
  );
  const { root, defaultExpandedPaths } = useMemo(
    () =>
      getStreamsSidebarState({
        streamPaths: filterStreamPaths(discoverStreamPaths(rootEvents), searchValue),
        currentStreamPath: selectedStreamPath,
      }),
    [rootEvents, searchValue, selectedStreamPath],
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<StreamPathType>>(new Set(["/"]));

  useEffect(() => {
    setExpandedPaths(new Set(defaultExpandedPaths));
  }, [defaultExpandedPaths]);

  function openCreateStreamForm() {
    setNewStreamPathInput("/some-stream");
    setIsCreatingStream(true);
  }

  function closeCreateStreamForm() {
    setIsCreatingStream(false);
    setNewStreamPathInput("");
  }

  function openStreamPath(path: StreamPathType) {
    void navigate({
      to: "/streams/$/",
      params: { _splat: streamPathToSplat(path) },
      search: (previous: StreamLinkSearch) => ({
        ...previous,
        ...streamSearch,
      }),
    });
  }

  function submitNewStreamPath() {
    const parsedPath = StreamPath.safeParse(newStreamPathInput.trim());
    if (!parsedPath.success) {
      toast.error(
        "Use lowercase letters, numbers, hyphens, underscores, and slashes only (e.g. my-stream or team/inbox).",
      );
      return;
    }

    if (parsedPath.data === "/") {
      toast.error("Pick a path under a non-root stream.");
      return;
    }

    openStreamPath(parsedPath.data);
    closeCreateStreamForm();
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Streams</SidebarGroupLabel>
      <SidebarGroupContent className="space-y-2 overflow-x-auto">
        {isCreatingStream ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              submitNewStreamPath();
            }}
          >
            <SidebarInput
              value={newStreamPathInput}
              onChange={(event) => setNewStreamPathInput(event.currentTarget.value)}
              onFocus={(event) => {
                if (event.currentTarget.value === "/some-stream") {
                  event.currentTarget.select();
                }
              }}
              placeholder="e.g. my-stream or team/inbox"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  closeCreateStreamForm();
                }
              }}
            />
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={closeCreateStreamForm}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" className="flex-1">
                Open
              </Button>
            </div>
          </form>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="h-9 w-full justify-start gap-2 px-2.5 font-normal"
            onClick={openCreateStreamForm}
          >
            <Plus className="size-4 shrink-0" />
            Create stream
          </Button>
        )}

        {!isConnecting || rootEvents.length > 0 ? (
          <>
            <SidebarInput
              value={searchValue}
              onChange={(event) => setSearchValue(event.currentTarget.value)}
              placeholder="Filter streams"
            />
            <SidebarMenu className="min-w-max">
              <StreamTreeItem
                depth={0}
                expandedPaths={expandedPaths}
                node={root}
                onTogglePath={(path) => {
                  setExpandedPaths((currentExpandedPaths) =>
                    toggleExpandedPath(currentExpandedPaths, path),
                  );
                }}
                selectedStreamPath={selectedStreamPath ?? undefined}
                streamSearch={streamSearch}
              />
            </SidebarMenu>
          </>
        ) : null}
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function StreamTreeItem({
  depth,
  expandedPaths,
  node,
  onTogglePath,
  selectedStreamPath,
  streamSearch,
}: {
  depth: number;
  expandedPaths: ReadonlySet<StreamPathType>;
  node: StreamsSidebarTreeNode;
  onTogglePath: (path: StreamPathType) => void;
  selectedStreamPath?: StreamPathType;
  streamSearch: ReturnType<typeof makeStreamSearch>;
}) {
  const isBranch = node.children.length > 0;
  const isExpanded = expandedPaths.has(node.path);
  const isSubRow = depth > 1;
  const rowClassName = "h-6 min-w-0 px-2 text-[10px] data-[active=true]:bg-transparent";

  if (isSubRow) {
    return (
      <SidebarMenuSubItem>
        <SidebarMenuSubButton
          render={<div />}
          isActive={selectedStreamPath === node.path}
          className={rowClassName}
        >
          <StreamBranchToggle
            isBranch={isBranch}
            isExpanded={isExpanded}
            onToggle={isBranch ? () => onTogglePath(node.path) : undefined}
          />
          <StreamPathLink
            path={node.path}
            childCount={countDescendantStreams(node)}
            streamSearch={streamSearch}
          />
        </SidebarMenuSubButton>
        {isBranch && isExpanded ? (
          <SidebarMenuSub className="mx-0 min-w-max border-l pl-3 pr-0">
            {node.children.map((childNode) => (
              <StreamTreeItem
                key={childNode.path}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                node={childNode}
                onTogglePath={onTogglePath}
                selectedStreamPath={selectedStreamPath}
                streamSearch={streamSearch}
              />
            ))}
          </SidebarMenuSub>
        ) : null}
      </SidebarMenuSubItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        render={<div />}
        isActive={selectedStreamPath === node.path}
        className={rowClassName}
      >
        <StreamBranchToggle
          isBranch={isBranch}
          isExpanded={isExpanded}
          onToggle={isBranch ? () => onTogglePath(node.path) : undefined}
        />
        <StreamPathLink
          path={node.path}
          childCount={countDescendantStreams(node)}
          streamSearch={streamSearch}
        />
      </SidebarMenuButton>
      {isBranch && isExpanded ? (
        depth === 0 ? (
          <SidebarMenu className="min-w-max">
            {node.children.map((childNode) => (
              <StreamTreeItem
                key={childNode.path}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                node={childNode}
                onTogglePath={onTogglePath}
                selectedStreamPath={selectedStreamPath}
                streamSearch={streamSearch}
              />
            ))}
          </SidebarMenu>
        ) : (
          <SidebarMenuSub className="mx-0 min-w-max border-l pl-3 pr-0">
            {node.children.map((childNode) => (
              <StreamTreeItem
                key={childNode.path}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                node={childNode}
                onTogglePath={onTogglePath}
                selectedStreamPath={selectedStreamPath}
                streamSearch={streamSearch}
              />
            ))}
          </SidebarMenuSub>
        )
      ) : null}
    </SidebarMenuItem>
  );
}

function StreamBranchToggle({
  isBranch,
  isExpanded,
  onToggle,
}: {
  isBranch: boolean;
  isExpanded: boolean;
  onToggle?: () => void;
}) {
  if (!isBranch) {
    return <span className="inline-flex size-3 shrink-0" aria-hidden="true" />;
  }

  return (
    <button
      type="button"
      className="inline-flex size-3 shrink-0 items-center justify-center rounded-sm text-muted-foreground/50 transition-colors hover:text-foreground"
      aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
      onClick={(event) => {
        event.stopPropagation();
        onToggle?.();
      }}
    >
      {isExpanded ? <Minus className="size-2.5" /> : <Plus className="size-2.5" />}
    </button>
  );
}

function StreamPathLink({
  path,
  childCount,
  streamSearch,
}: {
  path: StreamPathType;
  childCount: number;
  streamSearch: ReturnType<typeof makeStreamSearch>;
}) {
  return (
    <Link
      to="/streams/$/"
      params={{ _splat: streamPathToSplat(path) }}
      search={streamSearch}
      className="flex min-w-0 flex-1 items-center justify-between gap-2"
      onClick={(event: ReactMouseEvent<HTMLAnchorElement>) => {
        event.stopPropagation();
      }}
    >
      <StreamPathLabel
        path={path}
        label={getSidebarPathSegmentLabel(path)}
        className="leading-4 text-[10px]"
        startChars={14}
        endChars={12}
      />
      {childCount > 0 ? (
        <Badge
          variant="outline"
          className="h-4 shrink-0 rounded-sm px-1 font-mono text-[9px] font-normal tabular-nums text-muted-foreground"
        >
          {childCount}
        </Badge>
      ) : null}
    </Link>
  );
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

function toggleExpandedPath(expandedPaths: ReadonlySet<StreamPathType>, path: StreamPathType) {
  const nextExpandedPaths = new Set(expandedPaths);

  if (nextExpandedPaths.has(path)) {
    nextExpandedPaths.delete(path);
  } else {
    nextExpandedPaths.add(path);
  }

  return nextExpandedPaths;
}

function countDescendantStreams(node: StreamsSidebarTreeNode): number {
  return node.children.reduce(
    (count, childNode) => count + 1 + countDescendantStreams(childNode),
    0,
  );
}

function getSidebarPathSegmentLabel(path: StreamPathType) {
  if (path === "/") {
    return "/";
  }

  return `/${path.split("/").at(-1) ?? path}`;
}
